#!/usr/bin/env node

/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn, execSync } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { once } from 'node:events'

const execFile = promisify((cmd, args, callback) => {
	const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
	let stdout = ''
	let stderr = ''
	child.stdout.on('data', chunk => {
		stdout += chunk.toString()
	})
	child.stderr.on('data', chunk => {
		stderr += chunk.toString()
	})
	child.on('error', error => callback(error))
	child.on('close', code => {
		if (code === 0) {
			callback(null, { stdout, stderr })
		} else {
			const error = new Error(`Command ${cmd} exited with code ${code}: ${stderr}`)
			error.code = code
			callback(error)
		}
	})
})

const concurrencyLevels = process.env.LOAD_TEST_CONCURRENCY
	? process.env.LOAD_TEST_CONCURRENCY.split(',').map(value => parseInt(value.trim(), 10)).filter(Number.isFinite)
	: [50, 100, 500]

const testDurationSeconds = parseInt(process.env.LOAD_TEST_DURATION || '60', 10)
const updateRate = parseFloat(process.env.LOAD_TEST_RATE || '3')
const activeRatio = parseFloat(process.env.LOAD_TEST_ACTIVE_RATIO || '0.3')
const sharedSecret = process.env.LOAD_TEST_JWT_SECRET || 'benchmark-secret'

if (!Number.isFinite(testDurationSeconds) || testDurationSeconds <= 0) {
	throw new Error('Invalid LOAD_TEST_DURATION')
}

function parsePsOutput(output) {
	const trimmed = output.trim()
	if (!trimmed) {
		return null
	}
	const parts = trimmed.split(/\s+/)
	if (parts.length < 3) {
		return null
	}
	return {
		cpu: parseFloat(parts[0]),
		memPercent: parseFloat(parts[1]),
		rssKb: parseInt(parts[2], 10),
	}
}

async function readProcessStats(pid) {
	try {
		const { stdout } = await execFile('ps', ['-p', String(pid), '-o', '%cpu=,%mem=,rss='])
		return parsePsOutput(stdout)
	} catch {
		return null
	}
}

function startSampling(pid, intervalMs = 1000) {
	const samples = []
	let running = true

	const loop = async () => {
		while (running) {
			const stats = await readProcessStats(pid)
			if (stats) {
				samples.push({ ...stats, timestamp: Date.now() })
			}
			await delay(intervalMs)
		}
	}

	const loopPromise = loop()

	return {
		samples,
		stop: async () => {
			running = false
			await loopPromise
		},
	}
}

function parseNettop(pid) {
	try {
		const output = execSync(`nettop -P -x -J bytes_in,bytes_out -p ${pid} -l 1 -L 1`, { encoding: 'utf8' })
		const lines = output.trim().split('\n')
		const dataLine = lines.find(line => line.includes(`.${pid},`))
		if (!dataLine) {
			return { bytesIn: 0, bytesOut: 0 }
		}
		const parts = dataLine.split(',')
		return {
			bytesIn: parseInt(parts[2], 10) || 0,
			bytesOut: parseInt(parts[3], 10) || 0,
		}
	} catch {
		return { bytesIn: 0, bytesOut: 0 }
	}
}

function waitForServerReady(child) {
	return new Promise((resolve, reject) => {
		let resolved = false
		const handleOutput = (chunk) => {
			const text = chunk.toString()
			process.stdout.write(`[server] ${text}`)
			if (!resolved && text.includes('Server started successfully')) {
				resolved = true
				resolve()
			}
		}
		child.stdout.on('data', handleOutput)
		child.stderr.on('data', chunk => {
			process.stderr.write(`[server] ${chunk.toString()}`)
		})
		child.on('error', reject)
		child.on('exit', code => {
			if (!resolved) {
				reject(new Error(`Server exited with code ${code}`))
			}
		})
		setTimeout(() => {
			if (!resolved) {
				reject(new Error('Server startup timed out'))
			}
		}, 15000)
	})
}

async function runLoadTest(concurrency) {
	console.log(`\n=== Running ${concurrency} concurrent users ===`)

	const serverEnv = {
		...process.env,
		JWT_SECRET_KEY: sharedSecret,
		NEXTCLOUD_URL: 'http://localhost',
		TLS: 'false',
		NODE_OPTIONS: '--max-old-space-size=8192',
	}

	const server = spawn('node', ['websocket_server/main.js'], {
		env: serverEnv,
		stdio: ['ignore', 'pipe', 'pipe'],
	})

	await waitForServerReady(server)

	const baselineNetwork = parseNettop(server.pid)
	const sampler = startSampling(server.pid)

	const load = spawn('node', [
		'tools/benchmarks/loadTest.mjs',
		String(concurrency),
		String(testDurationSeconds),
		String(updateRate),
		String(activeRatio),
	], {
		env: {
			...process.env,
			LOAD_TEST_JWT_SECRET: sharedSecret,
			LOAD_TEST_SERVER_URL: 'http://127.0.0.1:3002',
			LOAD_TEST_ROOM_ID: 'benchmark-room',
		},
		stdio: ['ignore', 'pipe', 'inherit'],
	})

	let loadOutput = ''
	load.stdout.on('data', chunk => {
		const text = chunk.toString()
		loadOutput += text
		process.stdout.write(text)
	})

	const [loadCode] = await once(load, 'exit')

	await sampler.stop()

	const finalNetwork = parseNettop(server.pid)

	server.kill('SIGINT')
	await once(server, 'exit')

	if (loadCode !== 0) {
		throw new Error(`Load test process exited with code ${loadCode}`)
	}

	let loadSummary = null
	try {
		loadSummary = JSON.parse(loadOutput)
	} catch {
		throw new Error('Failed to parse load test output')
	}

	const { samples } = sampler
	const cpuValues = samples.map(sample => sample.cpu).filter(Number.isFinite)
	const rssValues = samples.map(sample => sample.rssKb).filter(Number.isFinite)

	const avgCpu = cpuValues.length ? cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length : 0
	const peakCpu = cpuValues.length ? Math.max(...cpuValues) : 0
	const avgRssMb = rssValues.length ? (rssValues.reduce((a, b) => a + b, 0) / rssValues.length) / 1024 : 0
	const peakRssMb = rssValues.length ? Math.max(...rssValues) / 1024 : 0

	const networkDelta = {
		bytesIn: Math.max(0, finalNetwork.bytesIn - baselineNetwork.bytesIn),
		bytesOut: Math.max(0, finalNetwork.bytesOut - baselineNetwork.bytesOut),
	}

	return {
		concurrency,
		cpu: {
			average: avgCpu,
			peak: peakCpu,
		},
		memory: {
			averageRssMb: avgRssMb,
			peakRssMb: peakRssMb,
		},
		network: networkDelta,
		loadSummary,
	}
}

const aggregatedResults = []
for (const level of concurrencyLevels) {
	const result = await runLoadTest(level)
	aggregatedResults.push(result)
}

console.log('\n=== Benchmark Summary ===')
console.log(JSON.stringify(aggregatedResults, null, 2))
