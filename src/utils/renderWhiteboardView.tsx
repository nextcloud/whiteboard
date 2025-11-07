/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { StrictMode, Suspense, lazy, type ComponentType } from 'react'
import { createRoot } from 'react-dom'

import type { WhiteboardAppProps } from '../App'

const App = lazy(() => import('../App'))
const CompareViewer = lazy(() => import('../components/CompareViewer'))

type ViewerFileInfo = {
	source?: string
	fileVersion?: string | null
}

type ComparisonMatchContext = {
	isViewerContext: boolean
}

const normalizeVersionSource = (source: string | null): string | null => {
	if (!source) {
		return null
	}
	try {
		const resolved = new URL(source, window.location.origin)
		return resolved.pathname + resolved.search
	} catch {
		return source
	}
}

const matchesComparisonRequest = (versionSource: string | null, fileVersion: string | null): boolean => {
	const compareInfo = window?.OCA?.Viewer?.compareFileInfo as ViewerFileInfo | undefined
	if (!compareInfo || typeof compareInfo !== 'object') {
		return false
	}

	const normalizedSource = normalizeVersionSource(versionSource)
	const compareSource = normalizeVersionSource(compareInfo.source ?? null)
	if (normalizedSource && compareSource && normalizedSource === compareSource) {
		return true
	}

	const compareVersion = compareInfo.fileVersion ?? null
	if (
		fileVersion
		&& compareVersion
		&& String(compareVersion) === String(fileVersion)
	) {
		return true
	}

	return false
}

export type RenderWhiteboardViewOptions = WhiteboardAppProps & {
	isComparisonView?: boolean
}

export type WhiteboardRootHandle = {
	unmount: () => void
}

const shouldRenderComparison = (
	props: Pick<RenderWhiteboardViewOptions, 'isComparisonView' | 'versionSource' | 'fileVersion'>,
	context: ComparisonMatchContext,
): boolean => {
	if (props.isComparisonView) {
		return true
	}
	if (!context.isViewerContext) {
		return false
	}
	return matchesComparisonRequest(props.versionSource, props.fileVersion ?? null)
}

export const renderWhiteboardView = (rootElement: HTMLElement, props: RenderWhiteboardViewOptions): WhiteboardRootHandle => {
	const root = createRoot(rootElement)
	const { isComparisonView, ...componentProps } = props
	const comparisonMode = shouldRenderComparison(
		{
			isComparisonView,
			versionSource: componentProps.versionSource,
			fileVersion: componentProps.fileVersion ?? null,
		},
		{ isViewerContext: Boolean(rootElement.closest('.viewer__content')) },
	)

	const ComponentToRender = (comparisonMode ? CompareViewer : App) as ComponentType<WhiteboardAppProps>

	root.render(
		<StrictMode>
			<Suspense fallback={<div>Loading…</div>}>
				<ComponentToRender {...componentProps as WhiteboardAppProps} />
			</Suspense>
		</StrictMode>,
	)

	return {
		unmount: () => root.unmount(),
	}
}

declare global {
	interface Window {
		OCA?: {
			Viewer?: {
				compareFileInfo?: ViewerFileInfo
			}
		}
	}
}
