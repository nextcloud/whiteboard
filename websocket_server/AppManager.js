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
		this.app.get('/heartbeat', this.heartbeatHandler.bind(this))
		this.app.put('/enabled', express.json(), this.enabledHandler.bind(this))
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

	heartbeatHandler(req, res) {
		res.status(200).json({ status: 'ok' })
	}

	async enabledHandler(req, res) {
		try {
			const authHeader = req.headers['authorization-app-api']

			if (!authHeader) {
				return res
					.status(401)
					.send('Unauthorized: Missing AUTHORIZATION-APP-API header')
			}

			const [userId, appSecret] = Buffer.from(authHeader, 'base64')
				.toString()
				.split(':')
			if (appSecret !== Config.EX_APP_SECRET) {
				return res.status(401).send('Unauthorized: Invalid APP_SECRET')
			}

			const headers = {
				'EX-APP-ID': Config.EX_APP_ID,
				'EX-APP-VERSION': Config.EX_APP_VERSION,
				'OCS-APIRequest': 'true',
				'AUTHORIZATION-APP-API': Buffer.from(
					`${userId}:${Config.EX_APP_SECRET}`,
				).toString('base64'),
				'Content-Type': 'application/json',
			}

			const response = await fetch(
				`${Config.NEXTCLOUD_URL}/index.php/apps/whiteboard/ex_app/settings`,
				{
					method: 'POST',
					headers,
					body: JSON.stringify({
						serverUrl: `${Config.NEXTCLOUD_WEBSOCKET_URL}/index.php/apps/app_api/proxy/whiteboard_websocket`,
						secret: Config.JWT_SECRET_KEY,
					}),
				},
			)

			if (!response.ok) {
				const responseBody = await response.text()
				throw new Error(
					`HTTP error! status: ${response.status}, body: ${responseBody}`,
				)
			}

			const data = await response.json()
			res.status(200).json(data)
		} catch (error) {
			console.error('Error updating Nextcloud config:', error)
			res
				.status(500)
				.send(`Failed to update Nextcloud configuration: ${error.message}`)
		}
	}

	getApp() {
		return this.app
	}

}
