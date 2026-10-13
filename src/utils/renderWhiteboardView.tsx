/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom'

import type { WhiteboardAppProps } from '../App'

const App = lazy(() => import('../App'))
const ReadOnlyViewer = lazy(() => import('../components/ReadOnlyViewer'))

export type RenderWhiteboardViewOptions = WhiteboardAppProps & {
    isComparisonView?: boolean
}

export type WhiteboardRootHandle = {
    unmount: () => void
}

export const renderWhiteboardView = (rootElement: HTMLElement, props: RenderWhiteboardViewOptions): WhiteboardRootHandle => {
	const root = createRoot(rootElement)
	const { isComparisonView, ...componentProps } = props

	const ComponentToRender = (componentProps.isEmbedded || isComparisonView)
		? ReadOnlyViewer
		: App

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
