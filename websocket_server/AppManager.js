/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import express from 'express'
import Config from './Config.js'

export default class AppManager {

	constructor(metricsManager) {
		this.app = express()
		this.metricsManager = metricsManager
		this.setupRoutes()
	}

	setupRoutes() {
		this.app.get('/', this.homeHandler.bind(this))
		this.app.get('/metrics', this.metricsHandler.bind(this))
	}

	homeHandler(req, res) {
		res.send('Excalidraw collaboration server is up :)')
	}

	async metricsHandler(req, res) {
		const token = req.headers.authorization?.split(' ')[1] || req.query.token
		if (!Config.METRICS_TOKEN || token !== Config.METRICS_TOKEN) {
			return res.status(403).send('Unauthorized')
		}
		this.metricsManager.updateMetrics()
		const metrics = await this.metricsManager.getRegister().metrics()
		res.set('Content-Type', this.metricsManager.getRegister().contentType)
		res.end(metrics)
	}

	getApp() {
		return this.app
	}

}
