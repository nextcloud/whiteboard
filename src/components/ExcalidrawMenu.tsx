/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, memo } from 'react'
import { Icon } from '@mdi/react'
import { mdiMonitorScreenshot } from '@mdi/js'
import { MainMenu } from '@excalidraw/excalidraw'
import { RecordingMenuItem } from './Recording'
import { PresentationMenuItem } from './Presentation'
import { CreatorMenuItem } from './CreatorMenuItem'

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
	startRecording: () => Promise<void>
	stopRecording: () => Promise<void>
	resetError: () => void
	dismissSuccess: () => void
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
			<MainMenu.DefaultItems.SaveAsImage />
			<MainMenu.Item
				icon={<Icon path={mdiMonitorScreenshot} size="16px" />}
				onSelect={takeScreenshot}>
				{'Download screenshot'}
			</MainMenu.Item>
			<RecordingMenuItem
				isRecording={recordingState.isRecording}
				isStarting={recordingState.isStarting}
				isStopping={recordingState.isStopping}
				startRecording={recordingState.startRecording}
				stopRecording={recordingState.stopRecording}
				isConnected={recordingState.isConnected}
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
