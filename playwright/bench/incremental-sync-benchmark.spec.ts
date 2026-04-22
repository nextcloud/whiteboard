/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Browser, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { test } from '../support/fixtures/random-user'
import {
	benchmarkMutations,
	benchmarkScenarios,
	formatBytes,
	selectMutations,
	selectScenarios,
	type BenchmarkMutation,
	type BenchmarkScenario,
	type MutationPlan,
} from '../support/incrementalSyncBenchmarkFixtures'
import {
	clearReceivedSceneMessages,
	clearCapturedSceneMessages,
	enableWhiteboardTestHooks,
	getCapturedSceneMessages,
	getReceivedSceneMessages,
	getScenePayloadBytes,
	installSceneEmitSpy,
	installSceneReceiveSpy,
	waitForCollaborationReady,
	waitForSceneElementCount,
} from '../support/incrementalSyncBenchmarkHooks'
import {
	addTextElement,
	captureBoardAuthFromSave,
	createWhiteboard,
	fetchBoardContent,
	newLoggedInPage,
	openFilesApp,
	openWhiteboardById,
	resolveFileIdByDav,
} from '../support/utils'

type BenchmarkConfig = {
	scenarios: string[]
	mutations: string[]
	scale: number
	runs: number
	outputPath: string | null
}

type BenchmarkSample = {
	totalElements: number
	plannedChangedElements: number
	changedElements: number
	bootstrapBytes: number
	fullUpdateBytes: number
	incrementalBytes: number
	lateJoinReadyMs: number
	incrementalEmitMs: number
	remoteApplyMs: number
}

type BenchmarkRow = {
	scenario: string
	mutation: string
	runs: number
	totalElements: number
	plannedChangedElements: number
	changedElements: number
	bootstrapBytes: number
	fullUpdateBytes: number
	incrementalBytes: number
	reductionPercent: string
	lateJoinReadyMs: string
	incrementalEmitMs: string
	remoteApplyMs: string
}

const benchmarkEnabled = process.env.WHITEBOARD_INCREMENTAL_SYNC_BENCH === '1'

function parseCsvEnv(name: string, fallback: string[]) {
	const raw = process.env[name]
	if (!raw) {
		return fallback
	}
	return raw.split(',').map((value) => value.trim()).filter(Boolean)
}

function parseIntegerEnv(name: string, fallback: number) {
	const raw = process.env[name]
	if (!raw) {
		return fallback
	}
	const value = parseInt(raw, 10)
	return Number.isFinite(value) && value > 0 ? value : fallback
}

function readConfig(): BenchmarkConfig {
	return {
		scenarios: parseCsvEnv('SYNC_BENCH_SCENARIOS', benchmarkScenarios.map((scenario) => scenario.key)),
		mutations: parseCsvEnv('SYNC_BENCH_MUTATIONS', benchmarkMutations.map((mutation) => mutation.key)),
		scale: parseIntegerEnv('SYNC_BENCH_SCALE', 1),
		runs: parseIntegerEnv('SYNC_BENCH_RUNS', 1),
		outputPath: process.env.SYNC_BENCH_OUTPUT_PATH?.trim() || null,
	}
}

function median(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b)
	const middle = Math.floor(sorted.length / 2)
	if (sorted.length % 2 === 0) {
		return (sorted[middle - 1] + sorted[middle]) / 2
	}
	return sorted[middle]
}

function formatMs(value: number) {
	return value.toFixed(1)
}

function aggregateSamples(
	scenario: BenchmarkScenario,
	mutation: BenchmarkMutation,
	runs: number,
	samples: BenchmarkSample[],
): BenchmarkRow {
	const bootstrapBytes = median(samples.map((sample) => sample.bootstrapBytes))
	const fullUpdateBytes = median(samples.map((sample) => sample.fullUpdateBytes))
	const incrementalBytes = median(samples.map((sample) => sample.incrementalBytes))
	const reductionPercent = fullUpdateBytes > 0
		? ((1 - (incrementalBytes / fullUpdateBytes)) * 100).toFixed(2)
		: '0.00'

	return {
		scenario: scenario.label,
		mutation: mutation.label,
		runs,
		totalElements: samples[0].totalElements,
		plannedChangedElements: samples[0].plannedChangedElements,
		changedElements: Math.round(median(samples.map((sample) => sample.changedElements))),
		bootstrapBytes: Math.round(bootstrapBytes),
		fullUpdateBytes: Math.round(fullUpdateBytes),
		incrementalBytes: Math.round(incrementalBytes),
		reductionPercent,
		lateJoinReadyMs: formatMs(median(samples.map((sample) => sample.lateJoinReadyMs))),
		incrementalEmitMs: formatMs(median(samples.map((sample) => sample.incrementalEmitMs))),
		remoteApplyMs: formatMs(median(samples.map((sample) => sample.remoteApplyMs))),
	}
}

async function waitForSceneMessage(page: Page, matcher: { transport: 'room' | 'direct', type: 'SCENE_INIT' | 'SCENE_UPDATE', emittedAtOrAfter: number }) {
	await page.waitForFunction((expected) => {
		const win = window as any
		const messages = win.__whiteboardTestHooks?.benchmarkSceneMessages || []
		return messages.some((message: any) => (
			message.transport === expected.transport
			&& message.type === expected.type
			&& Number(message.emittedAt) >= expected.emittedAtOrAfter
		))
	}, matcher, { timeout: 60_000 })

	const messages = await getCapturedSceneMessages(page)
	const match = messages.find((message) => (
		message.transport === matcher.transport
		&& message.type === matcher.type
		&& message.emittedAt >= matcher.emittedAtOrAfter
	))
	if (!match) {
		throw new Error(`Missing ${matcher.transport} ${matcher.type} message`)
	}
	return match
}

async function waitForReceivedSceneMessage(page: Page, matcher: { type: 'SCENE_INIT' | 'SCENE_UPDATE', receivedAtOrAfter: number }) {
	await page.waitForFunction((expected) => {
		const win = window as any
		const messages = win.__whiteboardTestHooks?.benchmarkReceivedSceneMessages || []
		return messages.some((message: any) => (
			message.type === expected.type
			&& Number(message.receivedAt) >= expected.receivedAtOrAfter
		))
	}, matcher, { timeout: 60_000 })

	const messages = await getReceivedSceneMessages(page)
	const match = messages.find((message) => (
		message.type === matcher.type
		&& message.receivedAt >= matcher.receivedAtOrAfter
	))
	if (!match) {
		throw new Error(`Missing received ${matcher.type} message`)
	}
	return match
}

async function applyMutation(page: Page, mutationPlan: MutationPlan) {
	await page.evaluate((elements) => {
		const win = window as any
		const api = win.__whiteboardTestHooks?.excalidrawStore?.getState?.().excalidrawAPI
		if (!api?.updateScene) {
			throw new Error('Excalidraw API not available')
		}
		api.updateScene({ elements })
	}, mutationPlan.elements)
}

async function seedBoardContent(
	page: Page,
	auth: { fileId: number, jwt: string },
	sceneData: { elements: MutationPlan['elements'], files?: Record<string, unknown>, appState?: Record<string, unknown> },
) {
	const response = await page.request.put(`apps/whiteboard/${auth.fileId}`, {
		headers: {
			Authorization: auth.jwt.startsWith('Bearer ') ? auth.jwt : `Bearer ${auth.jwt}`,
			'Content-Type': 'application/json',
			'X-Requested-With': 'XMLHttpRequest',
		},
		data: {
			data: {
				elements: sceneData.elements,
				files: sceneData.files || {},
				appState: sceneData.appState || {},
			},
		},
	})
	expect(response.ok()).toBeTruthy()
}

async function runBenchmarkSample(
	page: Page,
	browser: Browser,
	scenario: BenchmarkScenario,
	mutation: BenchmarkMutation,
	scale: number,
	runNumber: number,
) {
	const boardName = `Bench ${scenario.key} ${mutation.key} ${Date.now()} ${runNumber}`
	const fixture = scenario.build(scale)
	const mutationPlan = mutation.apply(fixture, scale)

	await openFilesApp(page)
	await enableWhiteboardTestHooks(page)
	await createWhiteboard(page, { name: boardName })
	await waitForCollaborationReady(page)
	const authCaptureText = `bench auth ${Date.now()}`
	const authPromise = captureBoardAuthFromSave(page, { containsText: authCaptureText })
	await addTextElement(page, authCaptureText)
	const fileId = await resolveFileIdByDav(page, boardName)
	if (!fileId) {
		throw new Error(`Failed to resolve file id for ${boardName}`)
	}
	const auth = await authPromise
	await seedBoardContent(page, auth, { elements: fixture.elements })
	const persistedBoard = await fetchBoardContent(page, auth)

	const persistedFixture = {
		...fixture,
		elements: Array.isArray((persistedBoard as any).elements) ? (persistedBoard as any).elements : fixture.elements,
	}
	const persistedMutationPlan = mutation.apply(persistedFixture, scale)

	const syncerPage = await newLoggedInPage(page, browser)
	try {
		await enableWhiteboardTestHooks(syncerPage)
		await openWhiteboardById(syncerPage, fileId)
		await waitForCollaborationReady(syncerPage)
		await waitForSceneElementCount(syncerPage, persistedFixture.elements.length)
		await syncerPage.waitForTimeout(800)
		await installSceneEmitSpy(syncerPage)
		await installSceneReceiveSpy(syncerPage)
		await clearCapturedSceneMessages(syncerPage)
		await clearReceivedSceneMessages(syncerPage)

		const pageB = await newLoggedInPage(page, browser)
		try {
			await enableWhiteboardTestHooks(pageB)
			const bootstrapStartedAt = Date.now()
			await openWhiteboardById(pageB, auth.fileId)
			await waitForCollaborationReady(pageB)

			const bootstrapMessage = await waitForSceneMessage(syncerPage, {
				transport: 'direct',
				type: 'SCENE_INIT',
				emittedAtOrAfter: bootstrapStartedAt,
			})
			const lateJoinReadyMs = bootstrapMessage.emittedAt - bootstrapStartedAt
			const bootstrapSettleMs = Math.min(1_200 + persistedFixture.elements.length * 5, 4_000)
			await pageB.waitForTimeout(bootstrapSettleMs)

			await installSceneEmitSpy(pageB)
			await clearCapturedSceneMessages(pageB)
			await clearReceivedSceneMessages(syncerPage)

			const mutationStartedAt = Date.now()
			await applyMutation(pageB, persistedMutationPlan)

			const incrementalMessage = await waitForSceneMessage(pageB, {
				transport: 'room',
				type: 'SCENE_UPDATE',
				emittedAtOrAfter: mutationStartedAt,
			})
			const incrementalEmitMs = incrementalMessage.emittedAt - mutationStartedAt

			const receivedMessage = await waitForReceivedSceneMessage(syncerPage, {
				type: 'SCENE_UPDATE',
				receivedAtOrAfter: mutationStartedAt,
			})
			const remoteApplyMs = receivedMessage.receivedAt - mutationStartedAt

			const fullUpdateBytes = await getScenePayloadBytes(pageB, 'SCENE_UPDATE')

			expect(incrementalMessage.syncAll).toBe(false)
			expect(receivedMessage.syncAll).toBe(false)
			expect(receivedMessage.elementsCount).toBe(incrementalMessage.elementsCount)

			return {
				totalElements: persistedMutationPlan.elements.length,
				plannedChangedElements: persistedMutationPlan.changedElements,
				changedElements: incrementalMessage.elementsCount,
				bootstrapBytes: bootstrapMessage.payloadBytes,
				fullUpdateBytes,
				incrementalBytes: incrementalMessage.payloadBytes,
				lateJoinReadyMs,
				incrementalEmitMs,
				remoteApplyMs,
			} satisfies BenchmarkSample
		} finally {
			await pageB.context().close()
		}
	} finally {
		await syncerPage.context().close()
	}
}

test.skip(!benchmarkEnabled, 'full-stack benchmark runner only')
test.describe.configure({ mode: 'serial' })

test('runs the incremental sync benchmark against the real Nextcloud stack', async ({ page, browser }) => {
	test.setTimeout(30 * 60 * 1000)

	const config = readConfig()
	const selectedScenarios = selectScenarios(config.scenarios)
	const selectedMutations = selectMutations(config.mutations)
	const rows: BenchmarkRow[] = []

	for (const scenario of selectedScenarios) {
		for (const mutation of selectedMutations) {
			const samples: BenchmarkSample[] = []
			for (let run = 1; run <= config.runs; run += 1) {
				console.log(`BENCHMARK_CASE|scenario=${scenario.key}|mutation=${mutation.key}|run=${run}/${config.runs}`)
				samples.push(await runBenchmarkSample(page, browser, scenario, mutation, config.scale, run))
			}
			rows.push(aggregateSamples(scenario, mutation, config.runs, samples))
		}
	}

	console.table(rows.map((row) => ({
		scenario: row.scenario,
		mutation: row.mutation,
		runs: row.runs,
		totalElements: row.totalElements,
		plannedChangedElements: row.plannedChangedElements,
		changedElements: row.changedElements,
		bootstrapPayload: formatBytes(row.bootstrapBytes),
		fullPayload: formatBytes(row.fullUpdateBytes),
		incrementalPayload: formatBytes(row.incrementalBytes),
		reduction: `${row.reductionPercent}%`,
		lateJoinReadyMs: row.lateJoinReadyMs,
		incrementalEmitMs: row.incrementalEmitMs,
		remoteApplyMs: row.remoteApplyMs,
	})))

	rows.forEach((row) => {
		console.log([
			'BENCHMARK_RESULT',
			`scenario=${row.scenario}`,
			`mutation=${row.mutation}`,
			`runs=${row.runs}`,
			`total_elements=${row.totalElements}`,
			`planned_changed_elements=${row.plannedChangedElements}`,
			`changed_elements=${row.changedElements}`,
			`bootstrap_bytes=${row.bootstrapBytes}`,
			`full_update_bytes=${row.fullUpdateBytes}`,
			`incremental_bytes=${row.incrementalBytes}`,
			`reduction_percent=${row.reductionPercent}`,
			`late_join_ready_ms=${row.lateJoinReadyMs}`,
			`incremental_emit_ms=${row.incrementalEmitMs}`,
			`remote_apply_ms=${row.remoteApplyMs}`,
		].join('|'))
	})

	if (config.outputPath) {
		const outputPath = resolve(config.outputPath)
		mkdirSync(dirname(outputPath), { recursive: true })
		writeFileSync(outputPath, JSON.stringify({
			timestamp: new Date().toISOString(),
			config,
			rows,
		}, null, 2))
		console.log(`BENCHMARK_OUTPUT|path=${outputPath}`)
	}
})
