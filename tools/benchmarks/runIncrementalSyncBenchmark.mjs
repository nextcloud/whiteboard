#!/usr/bin/env node

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from 'node:child_process'

const knownScenarios = ['retro-board', 'planning-flow', 'media-review']
const knownMutations = ['single-text-edit', 'selection-drag', 'mixed-session-burst']

function printHelp() {
	console.log(`Usage: npm run bench:incremental-sync -- [options]

Options:
  --scenario <name[,name]>    Scenario(s): ${knownScenarios.join(', ')}
  --mutation <name[,name]>    Mutation(s): ${knownMutations.join(', ')}
  --scale <n>                 Scale up the scene builders (default: 1)
  --runs <n>                  Full-stack runs per case (default: 1)
  --project <name>            Playwright project to use (default: chromium)
  --headed                    Run the browser headed
  --output-json <path>        Write machine-readable results to a JSON file
  --help                      Show this message

Examples:
  npm run bench:incremental-sync
  npm run bench:incremental-sync -- --scenario planning-flow --mutation selection-drag --runs 2
  npm run bench:incremental-sync -- --scenario retro-board,media-review --scale 2 --output-json tools/benchmarks/incremental-sync-results.json

This benchmark boots the Playwright Nextcloud test stack and measures actual
scene bootstrap and incremental sync payloads through the real whiteboard app.`)
}

function readOption(args, flag) {
	const index = args.indexOf(flag)
	if (index === -1) {
		return null
	}
	return args[index + 1] ?? null
}

const args = process.argv.slice(2)

if (args.includes('--help')) {
	printHelp()
	process.exit(0)
}

const scenario = readOption(args, '--scenario')
const mutation = readOption(args, '--mutation')
const scale = readOption(args, '--scale')
const runs = readOption(args, '--runs') ?? readOption(args, '--iterations')
const project = readOption(args, '--project') || 'chromium'
const outputJson = readOption(args, '--output-json')
const headed = args.includes('--headed')

const env = {
	...process.env,
	WHITEBOARD_INCREMENTAL_SYNC_BENCH: '1',
	...(scenario ? { SYNC_BENCH_SCENARIOS: scenario } : {}),
	...(mutation ? { SYNC_BENCH_MUTATIONS: mutation } : {}),
	...(scale ? { SYNC_BENCH_SCALE: scale } : {}),
	...(runs ? { SYNC_BENCH_RUNS: runs } : {}),
	...(outputJson ? { SYNC_BENCH_OUTPUT_PATH: outputJson } : {}),
}

const child = spawn('npx', [
	'playwright',
	'test',
	'playwright/bench/incremental-sync-benchmark.spec.ts',
	'--config=playwright.config.ts',
	'--project',
	project,
	'--workers=1',
	'--reporter=line',
	...(headed ? ['--headed'] : []),
], {
	env,
	stdio: 'inherit',
})

child.on('exit', (code) => {
	process.exit(code ?? 1)
})
