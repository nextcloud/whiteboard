/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useEffect, useRef, memo } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Icon } from '@mdi/react'
import { mdiMonitorScreenshot, mdiImageMultiple, mdiTimerOutline } from '@mdi/js'
import { MainMenu, CaptureUpdateAction } from '@nextcloud/excalidraw'
import { RecordingMenuItem } from './Recording'
import { PresentationMenuItem } from './Presentation'
import { CreatorMenuItem } from './CreatorMenuItem'
import { t } from '@nextcloud/l10n'
import { useShallow } from 'zustand/react/shallow'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types/types'
import { useExcalidrawStore } from '../stores/useExcalidrawStore'
import type { RecordingHookState } from '../types/recording'
import type { PresentationState } from '../types/presentation'

interface ExcalidrawMenuProps {
	fileNameWithoutExtension: string
	recordingState: RecordingHookState
	presentationState: PresentationState
	isTimerVisible: boolean
	onToggleTimer: () => void
}

export const ExcalidrawMenu = memo(function ExcalidrawMenu({ fileNameWithoutExtension, recordingState, presentationState, isTimerVisible, onToggleTimer }: ExcalidrawMenuProps) {
	const isMacPlatform = typeof navigator !== 'undefined' && (navigator.userAgentData?.platform === 'macOS' || /Mac|iPhone|iPad/.test(navigator.platform ?? ''))
	const { excalidrawAPI } = useExcalidrawStore(useShallow(state => ({
		excalidrawAPI: state.excalidrawAPI,
	})))

	const openExportDialog = useCallback(() => {
		// Trigger export by dispatching the keyboard shortcut to the Excalidraw canvas
		const excalidrawContainer = document.querySelector('.excalidraw') as HTMLElement
		if (excalidrawContainer) {
			const eventConfig: KeyboardEventInit = {
				key: 'e',
				code: 'KeyE',
				shiftKey: true,
				bubbles: true,
				cancelable: true,
			}
			if (isMacPlatform) {
				eventConfig.metaKey = true
			} else {
				eventConfig.ctrlKey = true
			}
			const event = new KeyboardEvent('keydown', eventConfig)
			excalidrawContainer.dispatchEvent(event)
		}
	}, [isMacPlatform])

	const takeScreenshot = useCallback(() => {
		const canvas = document.querySelector('.excalidraw__canvas') as HTMLCanvasElement | null
		if (!canvas) {
			return
		}

		const excalidrawContainer = document.querySelector('.excalidraw') as HTMLElement | null
		const previouslyFocused = document.activeElement as HTMLElement | null

		const dataUrl = canvas.toDataURL('image/png')
		const downloadLink = document.createElement('a')
		downloadLink.href = dataUrl
		downloadLink.download = `${fileNameWithoutExtension} Screenshot.png`
		document.body.appendChild(downloadLink)
		downloadLink.click()
		downloadLink.remove()

		const restoreFocus = () => {
			const focusTarget
				= previouslyFocused && previouslyFocused !== document.body
					? previouslyFocused
					: excalidrawContainer

			if (focusTarget && typeof focusTarget.focus === 'function') {
				try {
					focusTarget.focus({ preventScroll: true })
				} catch {
					focusTarget.focus()
				}
			}
		}

		requestAnimationFrame(restoreFocus)
	}, [fileNameWithoutExtension])

	const takeScreenshotRef = useRef(takeScreenshot)
	useEffect(() => {
		takeScreenshotRef.current = takeScreenshot
	}, [takeScreenshot])

	const isMacPlatformRef = useRef(isMacPlatform)
	useEffect(() => {
		isMacPlatformRef.current = isMacPlatform
	}, [isMacPlatform])

	const registeredApiRef = useRef<ExcalidrawImperativeAPI | null>(null)
	useEffect(() => {
		if (!excalidrawAPI) {
			registeredApiRef.current = null
			return
		}

		if (registeredApiRef.current === excalidrawAPI) {
			return
		}

		const screenshotShortcutAction = {
			name: 'whiteboard-download-screenshot',
			label: () => 'Download screenshot',
			trackEvent: false,
			viewMode: true,
			keyTest: (event: KeyboardEvent | ReactKeyboardEvent) => {
				if (event.repeat || !event.altKey) {
					return false
				}

				const shouldUseMetaKey = isMacPlatformRef.current
				const hasRequiredModifier = shouldUseMetaKey ? event.metaKey : event.ctrlKey
				if (!hasRequiredModifier) {
					return false
				}

				const keyCode = typeof event.code === 'string' ? event.code.toLowerCase() : ''
				if (keyCode !== 'keys') {
					return false
				}

				const target = event.target
				if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]')) {
					return false
				}

				return true
			},
			perform: () => {
				takeScreenshotRef.current()
				return { captureUpdate: CaptureUpdateAction.NEVER }
			},
		} as unknown as Parameters<ExcalidrawImperativeAPI['registerAction']>[0]

		excalidrawAPI.registerAction(screenshotShortcutAction)
		registeredApiRef.current = excalidrawAPI
	}, [excalidrawAPI])

	return (
		<MainMenu>
			<MainMenu.DefaultItems.ToggleTheme />
			<MainMenu.DefaultItems.ChangeCanvasBackground />
			<MainMenu.Separator />
			<MainMenu.Item
				icon={<Icon path={mdiImageMultiple} size={0.75} />}
				onSelect={openExportDialog}
				shortcut={isMacPlatform ? '⌘+⇧+E' : 'Ctrl+Shift+E'}>
				{t('whiteboard', 'Export image…')}
			</MainMenu.Item>
			<MainMenu.Item
				icon={<Icon path={mdiMonitorScreenshot} size={0.75} />}
				onSelect={takeScreenshot}
				shortcut={isMacPlatform ? '⌘+⌥+S' : 'Ctrl+Alt+S'}>
				{t('whiteboard', 'Download screenshot')}
			</MainMenu.Item>
			<RecordingMenuItem
				isRecording={recordingState.isRecording}
				isStarting={recordingState.isStarting}
				isStopping={recordingState.isStopping}
				startRecording={recordingState.startRecording}
				stopRecording={recordingState.stopRecording}
				isConnected={recordingState.isConnected}
				isAvailable={recordingState.isAvailable}
				unavailableReason={recordingState.unavailableReason}
			/>
			<MainMenu.Item
				icon={<Icon path={mdiTimerOutline} size={0.9} />}
				onSelect={onToggleTimer}>
				{isTimerVisible ? t('whiteboard', 'Hide timer') : t('whiteboard', 'Show timer')}
			</MainMenu.Item>
			<PresentationMenuItem
				isPresenting={presentationState.isPresenting}
				isPresentationMode={presentationState.isPresentationMode}
				presenterName={presentationState.presenterName}
				isStarting={presentationState.status === 'starting'}
				isStopping={presentationState.status === 'stopping'}
				startPresentation={presentationState.startPresentation}
				stopPresentation={presentationState.stopPresentation}
				isConnected={presentationState.isConnected}
			/>
			<CreatorMenuItem />
		</MainMenu>
	)
})
