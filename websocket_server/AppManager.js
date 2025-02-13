/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import express from 'express'
import Config from './Config.js'
import axios from 'axios'

export default class AppManager {

	constructor(metricsManager) {
		this.app = express()
		this.metricsManager = metricsManager
		this.setupRoutes()
	}

	setupRoutes() {
		this.app.get('/', this.homeHandler.bind(this))
		this.app.get('/status', this.statusHandler.bind(this))
		this.app.get('/metrics', this.metricsHandler.bind(this))
	}

	homeHandler(req, res) {
		res.send('Excalidraw collaboration server is up :)')
	}

	async statusHandler(req, res) {
		const NEXTCLOUD_URL = process.env.NEXTCLOUD_URL

		// Rather simple connectivity check, but should do the trick for most cases
		const statusUrl = NEXTCLOUD_URL + '/status.php'
		let connectBack
		try {
			const response = await axios.get(statusUrl, {
				timeout: 5000,
			})
			connectBack = response.data?.version ? true : ('No version found when requesting ' + statusUrl)
		} catch (e) {
			console.error(e)
			connectBack = e?.message
		}

		res.set('Content-Type', 'application/json')
		res.send(JSON.stringify({
			version: process.env.npm_package_version,
			connectBack: connectBack === true,
			connectBackMessage: connectBack === true ? 'Connection successful' : connectBack,
		}))
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
