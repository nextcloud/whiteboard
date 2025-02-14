/**
 * SPDX-FileCopyrightText: 2020 Excalidraw
 * SPDX-License-Identifier: MIT
 */

// https://github.com/excalidraw/excalidraw/blob/4dc4590f247a0a0d9c3f5d39fe09c00c5cef87bf/examples/excalidraw/utils.ts

/* eslint-disable @typescript-eslint/no-explicit-any */

/* eslint-disable-next-line camelcase */
import { unstable_batchedUpdates } from 'react-dom'

export const throttleRAF = <T extends any[]>(
	fn: (...args: T) => void,
	opts?: { trailing?: boolean },
) => {
	let timerId: number | null = null
	let lastArgs: T | null = null
	let lastArgsTrailing: T | null = null

	const scheduleFunc = (args: T) => {
		timerId = window.requestAnimationFrame(() => {
			timerId = null
			fn(...args)
			lastArgs = null
			if (lastArgsTrailing) {
				lastArgs = lastArgsTrailing
				lastArgsTrailing = null
				scheduleFunc(lastArgs)
			}
		})
	}

	const ret = (...args: T) => {
		if (process.env.NODE_ENV === 'test') {
			fn(...args)
			return
		}
		lastArgs = args
		if (timerId === null) {
			scheduleFunc(lastArgs)
		} else if (opts?.trailing) {
			lastArgsTrailing = args
		}
	}
	ret.flush = () => {
		if (timerId !== null) {
			cancelAnimationFrame(timerId)
			timerId = null
		}
		if (lastArgs) {
			fn(...(lastArgsTrailing || lastArgs))
			lastArgs = lastArgsTrailing = null
		}
	}
	ret.cancel = () => {
		lastArgs = lastArgsTrailing = null
		if (timerId !== null) {
			cancelAnimationFrame(timerId)
			timerId = null
		}
	}
	return ret
}

export const withBatchedUpdates = <
  TFunction extends ((event: any) => void) | (() => void)
>(
		func: Parameters<TFunction>['length'] extends 0 | 1 ? TFunction : never,
	) =>
		((event) => {
			unstable_batchedUpdates(func as TFunction, event)
		}) as TFunction

export const withBatchedUpdatesThrottled = <
  TFunction extends ((event: any) => void) | (() => void)
>(
		func: Parameters<TFunction>['length'] extends 0 | 1 ? TFunction : never,
	) => {
	// @ts-ingore
	return throttleRAF<Parameters<TFunction>>(((event) => {
		unstable_batchedUpdates(func, event)
	}) as TFunction)
}

export const distance2d = (x1: number, y1: number, x2: number, y2: number) => {
	const xd = x2 - x1
	const yd = y2 - y1
	return Math.hypot(xd, yd)
}

export const resolvablePromise = () => {
	let resolve!: any
	let reject!: any
	const promise = new Promise((_resolve, _reject) => {
		resolve = _resolve
		reject = _reject
	});
	(promise as any).resolve = resolve;
	(promise as any).reject = reject
	return promise as ResolvablePromise<any>
}

export const formatSizeInBytes = (size: number) => {
	const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
	if (size === 0) return '0 Byte'
	const i = parseInt(Math.floor(Math.log(size) / Math.log(1024)))
	return `${Math.round(size / Math.pow(1024, i), 2)} ${sizes[i]}`
}

export const debounce = (func: any, wait: number, immediate = false) => {
	let timeout: any
	return function(self: any, ...args: any[]) {
		const context = self
		const later = function() {
			timeout = null
			if (!immediate) func.apply(context, args)
		}
		const callNow = immediate && !timeout
		clearTimeout(timeout)
		timeout = setTimeout(later, wait)
		if (callNow) func.apply(context, args)
	}
}

export function getTimeFrames(type: string) {
	const timeframes = []
	const now = new Date()
	const from = new Date()
	from.setSeconds(0)
	let fromTimeMs = from.getTime()

	switch (type) {
	case 'last-24h':
		from.setDate(from.getDate() - 1)
		fromTimeMs = from.getTime()
		while (fromTimeMs < now.getTime()) {
			const fromTime = parseInt(from.getTime() / 1000)
			from.setHours(from.getHours() + 1)
			const toTime = parseInt(from.getTime() / 1000)
			timeframes.push({
				from: fromTime,
				to: toTime,
			})
			fromTimeMs = from.getTime()
		}
		break
	case 'last-7days':
		from.setDate(from.getDate() - 7)
		fromTimeMs = from.getTime()
		while (fromTimeMs < now.getTime()) {
			const fromTime = parseInt(from.getTime() / 1000)
			from.setDate(from.getDate() + 1)
			const toTime = parseInt(from.getTime() / 1000)
			timeframes.push({
				from: fromTime,
				to: toTime,
			})
			fromTimeMs = from.getTime()
		}
		break
	case 'last-30-days':
		from.setMonth(from.getMonth() - 1)
		fromTimeMs = from.getTime()
		while (fromTimeMs < now.getTime()) {
			const fromTime = parseInt(from.getTime() / 1000)
			from.setDate(from.getDate() + 1)
			const toTime = parseInt(from.getTime() / 1000)
			timeframes.push({
				from: fromTime,
				to: toTime,
			})
			fromTimeMs = from.getTime()
		}
		break
	case 'last-hour':
	default:
		from.setHours(from.getHours() - 1)
		fromTimeMs = from.getTime()
		while (fromTimeMs < now.getTime()) {
			const fromTime = parseInt(from.getTime() / 1000)
			from.setMinutes(from.getMinutes() + 5)
			const toTime = parseInt(from.getTime() / 1000)
			timeframes.push({
				from: fromTime,
				to: toTime,
			})
			fromTimeMs = from.getTime()
		}
		break
	}

	return timeframes
}

export function getLabelsFromTimeFrames(timeframes: any[], type: string) {
	const labels = []

	switch (type) {
	case 'last-24h':
		timeframes.forEach((item) => {
			const from = new Date(item.from * 1000)
			let hour = from.getHours()
			hour = hour < 10 ? `0${hour}` : hour
			const label = `${hour}:00`
			labels.push(label)
		})
		break
	case 'last-7days':
		timeframes.forEach((item) => {
			const from = new Date(item.from * 1000)
			labels.push(from.toLocaleDateString())
		})
		break
	case 'last-30-days':
		timeframes.forEach((item) => {
			const from = new Date(item.from * 1000)
			const label = `${from.getDate()}.${from.getMonth() + 1}`
			labels.push(label)
		})
		break
	case 'last-hour':
	default:
		timeframes.forEach((item) => {
			const from = new Date(item.from * 1000)
			let hour = from.getHours()
			hour = hour < 10 ? `0${hour}` : hour
			let minutes = from.getMinutes()
			minutes = minutes < 10 ? `0${minutes}` : minutes
			const label = `${hour}:${minutes}`
			labels.push(label)
		})
		break
	}

	return labels
}
