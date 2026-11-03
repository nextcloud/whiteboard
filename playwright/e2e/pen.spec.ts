/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import { createWhiteboard, getCanvasForInteraction, openFilesApp } from '../support/utils'

test('a fast pen stroke keeps its path while the page is busy', async ({ page }) => {
	await page.addInitScript(() => {
		;(window as any).__whiteboardTest = true
	})
	await openFilesApp(page)
	await createWhiteboard(page, { name: `Pen ${Date.now()}` })
	await page.evaluate(() => {
		(window as any).__whiteboardTestHooks.excalidrawStore.getState().excalidrawAPI.setActiveTool({ type: 'freedraw' })
	})

	const box = (await (await getCanvasForInteraction(page)).boundingBox())!
	// a half circle of 60 samples
	const points = Array.from({ length: 61 }, (_, i) => {
		const angle = Math.PI - (Math.PI * i) / 60
		return { x: box.x + 500 + 150 * Math.cos(angle), y: box.y + 400 - 150 * Math.sin(angle) }
	})
	const cdp = await page.context().newCDPSession(page)
	const pen = (type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', { x, y }: { x: number, y: number }) => cdp.send('Input.dispatchMouseEvent', {
		type,
		x,
		y,
		button: 'left',
		buttons: type === 'mouseReleased' ? 0 : 1,
		clickCount: 1,
		pointerType: 'pen',
		force: 0.7,
	})

	await pen('mousePressed', points[0])
	// Moves sent while the main thread is busy reach the board in a burst at the next frame
	await page.evaluate(() => setTimeout(() => {
		const end = performance.now() + 400
		while (performance.now() < end) { /* busy */ }
	}))
	await page.waitForTimeout(30)
	await Promise.all(points.slice(1).map((point) => pen('mouseMoved', point)))
	await pen('mouseReleased', points[points.length - 1])

	// the stroke on screen, then how far the half circle gets from it
	type Point = { x: number, y: number }
	const stroke = async (): Promise<Point[]> => page.evaluate(() => {
		const api = (window as any).__whiteboardTestHooks.excalidrawStore.getState().excalidrawAPI
		const element = api.getSceneElements().find((candidate: { type: string }) => candidate.type === 'freedraw')
		const { scrollX, scrollY, zoom, offsetLeft, offsetTop } = api.getAppState()
		return (element?.points ?? []).map(([x, y]: [number, number]) => ({
			x: (element.x + x + scrollX) * zoom.value + offsetLeft,
			y: (element.y + y + scrollY) * zoom.value + offsetTop,
		}))
	})
	const distanceToSegment = (p: Point, a: Point, b: Point) => {
		const dx = b.x - a.x
		const dy = b.y - a.y
		const length = dx * dx + dy * dy
		const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0
		return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
	}
	const largestGap = async () => {
		const drawn = await stroke()
		if (drawn.length < 2) {
			return Infinity
		}
		return Math.max(...points.map((point) => Math.min(...drawn.slice(1).map((end, i) => distanceToSegment(point, drawn[i], end)))))
	}
	await expect.poll(async () => (await stroke()).length).toBeGreaterThan(55)
	expect(await largestGap()).toBeLessThan(1)
})
