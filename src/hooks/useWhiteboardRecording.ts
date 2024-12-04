/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useState, useRef, useCallback } from 'react'
import { showError, showSuccess } from '@nextcloud/dialogs'
import { translate as t } from '@nextcloud/l10n'

interface ExtendedMediaRecorder extends MediaRecorder {
	animationFrameId?: number
}

export interface RecordingState {
	isRecording: boolean
	duration: number
	frames: Blob[]
}

interface CanvasParams {
	staticCanvas: HTMLCanvasElement
	interactiveCanvas: HTMLCanvasElement
}

export function useWhiteboardRecording() {
	const [recordingState, setRecordingState] = useState<RecordingState>({
		isRecording: false,
		duration: 0,
		frames: [],
	})

	const mediaRecorderRef = useRef<ExtendedMediaRecorder | null>(null)
	const streamRef = useRef<MediaStream | null>(null)
	const durationIntervalRef = useRef<number | null>(null)
	const animationFrameIdRef = useRef<number | null>(null)

	const startRecording = useCallback(({ staticCanvas, interactiveCanvas }: CanvasParams) => {
		try {
			const combinedCanvas = document.createElement('canvas')
			const ctx = combinedCanvas.getContext('2d')
			if (!ctx) {
				throw new Error('Failed to get canvas context')
			}

			combinedCanvas.width = staticCanvas.width
			combinedCanvas.height = staticCanvas.height

			const drawFrame = () => {

				ctx.clearRect(0, 0, combinedCanvas.width, combinedCanvas.height)

				ctx.drawImage(staticCanvas, 0, 0)

				ctx.drawImage(interactiveCanvas, 0, 0)
			}

			const stream = combinedCanvas.captureStream(60)
			streamRef.current = stream

			const updateCanvas = () => {
				drawFrame()
				animationFrameIdRef.current = requestAnimationFrame(updateCanvas)
			}
			updateCanvas()

			const mediaRecorder = new MediaRecorder(stream, {
				mimeType: 'video/webm;codecs=vp8',
				videoBitsPerSecond: 8000000,
			}) as ExtendedMediaRecorder

			mediaRecorder.ondataavailable = (event) => {
				setRecordingState((prev) => ({
					...prev,
					frames: [...prev.frames, event.data],
				}))
			}

			mediaRecorder.start(500)
			mediaRecorderRef.current = mediaRecorder

			durationIntervalRef.current = window.setInterval(() => {
				setRecordingState((prev) => ({
					...prev,
					duration: prev.duration + 1,
				}))
			}, 1000)

			setRecordingState((prev) => ({
				...prev,
				isRecording: true,
				duration: 0,
				frames: [],
			}))

			showSuccess(t('whiteboard', 'Recording started'))
		} catch (error) {
			// eslint-disable-next-line no-console
			console.error('Failed to start recording:', error)
			showError(t('whiteboard', 'Failed to start recording'))
		}
	}, [])

	const stopRecording = useCallback(async () => {
		if (!mediaRecorderRef.current || !streamRef.current) {
			return
		}

		if (animationFrameIdRef.current !== null) {
			cancelAnimationFrame(animationFrameIdRef.current)
			animationFrameIdRef.current = null
		}

		mediaRecorderRef.current.stop()

		streamRef.current.getTracks().forEach((track) => track.stop())

		if (durationIntervalRef.current) {
			clearInterval(durationIntervalRef.current)
		}

		setRecordingState((prev) => ({
			...prev,
			isRecording: false,
		}))

		showSuccess(t('whiteboard', 'Recording stopped'))
	}, [])

	const downloadRecording = useCallback(() => {
		if (recordingState.frames.length === 0) {
			return
		}

		try {
			const blob = new Blob(recordingState.frames, { type: 'video/webm' })
			const url = URL.createObjectURL(blob)

			const a = document.createElement('a')
			a.href = url
			a.download = `whiteboard-recording-${Date.now()}.webm`
			document.body.appendChild(a)
			a.click()
			document.body.removeChild(a)
			URL.revokeObjectURL(url)

			showSuccess(t('whiteboard', 'Recording saved'))
		} catch (error) {
			// eslint-disable-next-line no-console
			console.error('Failed to save recording:', error)
			showError(t('whiteboard', 'Failed to save recording'))
		}
	}, [recordingState.frames])

	return {
		recordingState,
		startRecording,
		stopRecording,
		downloadRecording,
	}
}
