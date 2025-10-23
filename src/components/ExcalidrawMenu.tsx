/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, memo } from 'react'
import { Icon } from '@mdi/react'
import { mdiMonitorScreenshot, mdiImageMultiple } from '@mdi/js'
import { MainMenu } from '@nextcloud/excalidraw'
import { RecordingMenuItem } from './Recording'
import { PresentationMenuItem } from './Presentation'
import { CreatorMenuItem } from './CreatorMenuItem'
import { t } from '@nextcloud/l10n'

interface RecordingState {
	isRecording: boolean
	error: string | null
	startTime: number | null
	status: 'idle' | 'starting' | 'recording' | 'stopping'
	duration: number | null
	otherUsers: Array<{ userId: string; username: string }>
	fileUrl: string | null
	showSuccess: boolean
	hasError: boolean
	isStarting: boolean
	isStopping: boolean
	hasOtherRecordingUsers: boolean
	isConnected: boolean
	isAvailable: boolean | null
	unavailableReason: string | null
	showUnavailableInfo: boolean
	startRecording: () => Promise<void>
	stopRecording: () => Promise<void>
	resetError: () => void
	dismissSuccess: () => void
	dismissUnavailableInfo: () => void
}

interface PresentationState {
	isPresenting: boolean
	isPresentationMode: boolean
	presenterId: string | null
	presenterName: string | null
	presentationStartTime: number | null
	autoFollowPresenter: boolean
	status: 'idle' | 'starting' | 'presenting' | 'stopping'
	error: string | null
	isConnected: boolean
	startPresentation: () => Promise<void>
	stopPresentation: () => Promise<void>
	toggleAutoFollow: () => void
	resetError: () => void
}

interface ExcalidrawMenuProps {
	fileNameWithoutExtension: string
	recordingState: RecordingState
	presentationState: PresentationState
}

export const ExcalidrawMenu = memo(function ExcalidrawMenu({ fileNameWithoutExtension, recordingState, presentationState }: ExcalidrawMenuProps) {
	const isMacPlatform = typeof navigator !== 'undefined' && (navigator.userAgentData?.platform === 'macOS' || /Mac|iPhone|iPad/.test(navigator.platform ?? ''))

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
		const canvas = document.querySelector('.excalidraw__canvas') as HTMLCanvasElement
		if (canvas) {
			const dataUrl = canvas.toDataURL('image/png')
			const downloadLink = document.createElement('a')
			downloadLink.href = dataUrl
			downloadLink.download = `${fileNameWithoutExtension} Screenshot.png`
			document.body.appendChild(downloadLink)
			downloadLink.click()
		}
	}, [fileNameWithoutExtension])

	return (
		<MainMenu>
			<MainMenu.DefaultItems.ToggleTheme />
			<MainMenu.DefaultItems.ChangeCanvasBackground />
			<MainMenu.Separator />
			<MainMenu.Item
				icon={<Icon path={mdiImageMultiple} size={0.75} />}
				onSelect={openExportDialog}
				shortcut={isMacPlatform ? '⌘+⇧+E' : 'Ctrl+Shift+E'}>
				{t('whiteboard', 'Export image...')}
			</MainMenu.Item>
			<MainMenu.Item
				icon={<Icon path={mdiMonitorScreenshot} size={0.75} />}
				onSelect={takeScreenshot}>
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
