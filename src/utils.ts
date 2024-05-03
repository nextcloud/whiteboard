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
