/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import dotenv from 'dotenv'
import express from 'express'
import PrometheusDataManager from './PrometheusDataManager.js'
import fetch from 'node-fetch'
import getOrCreateJwtSecretKey from './JwtSecretManager.js'
dotenv.config()

export default class AppManager {

	constructor(storageManager) {
		this.app = express()
		this.metricsManager = new PrometheusDataManager(storageManager)
		this.METRICS_TOKEN = process.env.METRICS_TOKEN
		this.JWT_SECRET_KEY = getOrCreateJwtSecretKey()
		this.setupRoutes()
	}

	setupRoutes() {
		this.app.get('/', this.homeHandler.bind(this))
		this.app.get('/metrics', this.metricsHandler.bind(this))
		this.app.get('/heartbeat', this.heartbeatHandler.bind(this))
		this.app.put('/enabled', express.json(), this.enabledHandler.bind(this))
	}

	homeHandler(req, res) {
		res.send('Excalidraw collaboration server is up :)')
	}

	async metricsHandler(req, res) {
		const token = req.headers.authorization?.split(' ')[1] || req.query.token
		if (!this.METRICS_TOKEN || token !== this.METRICS_TOKEN) {
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

			console.log('authHeader', authHeader)

			if (!authHeader) {
				return res
					.status(401)
					.send('Unauthorized: Missing AUTHORIZATION-APP-API header')
			}

			const [userId, appSecret] = Buffer.from(authHeader, 'base64')
				.toString()
				.split(':')
			if (appSecret !== process.env.APP_SECRET) {
				return res.status(401).send('Unauthorized: Invalid APP_SECRET')
			}

			const headers = {
				'EX-APP-ID': process.env.APP_ID,
				'EX-APP-VERSION': process.env.APP_VERSION,
				'OCS-APIRequest': 'true',
				'AUTHORIZATION-APP-API': Buffer.from(
					`${userId}:${process.env.APP_SECRET}`,
				).toString('base64'),
				'Content-Type': 'application/json',
			}

			const response = await fetch(
				'http://nextcloud/index.php/apps/whiteboard/settings',
				{
					method: 'POST',
					headers,
					body: JSON.stringify({
						serverUrl: `${process.env.NEXTCLOUD_URL}/apps/app_api/proxy/whiteboard_websocket`,
						secret: this.JWT_SECRET_KEY,
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
