/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import dotenv from 'dotenv'
import express from 'express'
import { register } from 'prom-client'
import { getSystemOverview } from './monitoring.js'
import { rooms } from './roomData.js'

dotenv.config()

const METRICS_TOKEN = process.env.METRICS_TOKEN

const app = express()

app.get('/', (req, res) => {
	res.send('Excalidraw collaboration server is up :)')
})

app.get('/metrics', async (req, res) => {
	const token = req.headers.authorization?.split(' ')[1] || req.query.token
	if (!METRICS_TOKEN || token !== METRICS_TOKEN) {
		return res.status(403).send('Unauthorized')
	}
	const metrics = await register.metrics()
	res.set('Content-Type', register.contentType)
	res.end(metrics)
})

app.get('/system-overview', (req, res) => {
	res.json(getSystemOverview(rooms))
})

export default app
