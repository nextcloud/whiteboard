/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import express from 'express'
import axios from 'axios'
import Config from './Config.js'

export default class AppManager {

	constructor(systemMonitor, metricsManager) {
		this.app = express()
		this.systemMonitor = systemMonitor
		this.metricsManager = metricsManager
		this.setupRoutes()
	}

	setupRoutes() {
		this.app.get('/', this.homeHandler.bind(this))
		this.app.get('/status', this.statusHandler.bind(this))

		// Setup metrics endpoint if metrics token is configured
		if (Config.METRICS_TOKEN) {
			this.app.get('/metrics', this.metricsHandler.bind(this))
		}
	}

	/**
	 * Handler for the metrics endpoint
	 * @param {express.Request} req - The Express request object
	 * @param {express.Response} res - The Express response object
	 */
	metricsHandler(req, res) {
		// Check authentication
		const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '')
		if (token !== Config.METRICS_TOKEN) {
			return res.status(403).send('Unauthorized')
		}

		// Check if metrics manager is available
		if (!this.metricsManager) {
			return res.status(500).send('Metrics not configured')
		}

		// Update metrics before sending
		this.metricsManager.updateMetrics()

		// Get the Prometheus register and send metrics
		const register = this.metricsManager.getRegister()
		res.set('Content-Type', register.contentType)
		register.metrics().then(metrics => {
			res.send(metrics)
		}).catch(err => {
			console.error('Error generating metrics:', err)
			res.status(500).send('Error generating metrics')
		})
	}

	homeHandler(req, res) {
		res.send('Nextcloud Whiteboard Collaboration Server')
	}

	async statusHandler(req, res) {
		const NEXTCLOUD_URL = Config.NEXTCLOUD_URL

		// Check connectivity to Nextcloud
		const statusUrl = NEXTCLOUD_URL + '/status.php'
		let connectBack
		try {
			const response = await axios.get(statusUrl, {
				timeout: 5000,
			})
			connectBack = response.data?.version ? true : ('No version found when requesting ' + statusUrl)
		} catch (e) {
			console.error('Error connecting to Nextcloud:', e.message)
			connectBack = e?.message
		}

		// Get system stats if systemMonitor is available
		let roomStats = {}
		let memoryStats = {}
		let cacheStats = {}
		if (this.systemMonitor) {
			try {
				const overview = this.systemMonitor.getSystemOverview()

				// Get room statistics
				if (overview.roomStats && !overview.roomStats.error) {
					roomStats = {
						activeRooms: overview.roomStats.activeRooms || 0,
						connectedClients: overview.roomStats.connectedClients || 0,
					}
				}

				// Get memory statistics
				if (overview.memoryUsage) {
					memoryStats = {
						rss: overview.memoryUsage.rssFormatted || '0 Bytes',
						heapUsed: overview.memoryUsage.heapUsedFormatted || '0 Bytes',
						heapTotal: overview.memoryUsage.heapTotalFormatted || '0 Bytes',
					}
				}

				// Get cache statistics
				if (overview.cacheStats && !overview.cacheStats.error) {
					cacheStats = {
						type: overview.cacheStats.type || 'unknown',
						size: overview.cacheStats.size || 0,
						maxSize: overview.cacheStats.maxSize || 0,
					}
				}
			} catch (error) {
				console.error('Error getting system stats:', error)
			}
		}

		// Prepare the response with the original structure
		const response = {
			version: process.env.npm_package_version,
			connectBack: connectBack === true,
			connectBackMessage: connectBack === true ? 'Connection successful' : connectBack,
		}

		// Add additional metrics data without breaking the original structure
		response.metrics = {
			rooms: roomStats,
			memory: memoryStats,
			cache: cacheStats,
			uptime: this.systemMonitor ? this.systemMonitor.getUptime().processFormatted : '0s',
			storageStrategy: Config.STORAGE_STRATEGY,
			redisEnabled: !!Config.REDIS_URL,
			metricsEnabled: !!Config.METRICS_TOKEN,
		}

		res.set('Content-Type', 'application/json')
		res.send(JSON.stringify(response))
	}

	getApp() {
		return this.app
	}

}
