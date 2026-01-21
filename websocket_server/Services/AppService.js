/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* eslint-disable no-console */

import express from 'express'
import Config from '../Utilities/ConfigUtility.js'

export default class AppService {

	constructor(systemMonitor, metricsService) {
		this.app = express()
		this.systemMonitor = systemMonitor
		this.metricsService = metricsService
		this.corsHeaders = [
			'Content-Type',
			'Authorization',
			'X-Requested-With',
		]
		this.app.use((req, res, next) => {
			if (this.setCorsHeaders(req, res) && req.method === 'OPTIONS') {
				res.status(204).end()
				return
			}
			next()
		})
		this.setupRoutes()
	}

	setupRoutes() {
		this.app.get('/', this.homeHandler.bind(this))
		this.app.options('/status', this.statusOptionsHandler.bind(this))
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

		// Check if metrics service is available
		if (!this.metricsService) {
			return res.status(500).send('Metrics not configured')
		}

		// Update metrics before sending
		this.metricsService.updateMetrics()

		// Get the Prometheus register and send metrics
		const register = this.metricsService.getRegister()
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

	setCorsHeaders(req, res) {
		const origin = req.headers.origin
		if (!origin || !Config.CORS_ORIGINS.includes(origin)) {
			return false
		}
		res.set('Access-Control-Allow-Origin', origin)
		const requestHeaders = req.headers['access-control-request-headers']
		res.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
		if (requestHeaders) {
			res.set('Access-Control-Allow-Headers', requestHeaders)
		} else {
			res.set('Access-Control-Allow-Headers', this.corsHeaders.join(', '))
		}
		res.set('Vary', 'Origin')
		return true
	}

	statusOptionsHandler(req, res) {
		if (!this.setCorsHeaders(req, res)) {
			res.status(403).end()
			return
		}
		res.status(204).end()
	}

	async statusHandler(req, res) {
		this.setCorsHeaders(req, res)

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

		// Simple status response for monitoring/health checks
		const response = {
			version: process.env.npm_package_version,
			status: 'running',
			config: {
				maxUploadFileSizeBytes: Config.MAX_UPLOAD_FILE_SIZE,
				maxHttpBufferSizeBytes: Config.MAX_UPLOAD_FILE_SIZE + 1e6,
			},
			metrics: {
				rooms: roomStats,
				memory: memoryStats,
				cache: cacheStats,
				uptime: this.systemMonitor ? this.systemMonitor.getUptime().processFormatted : '0s',
				storageStrategy: Config.STORAGE_STRATEGY,
				redisEnabled: !!Config.REDIS_URL,
				metricsEnabled: !!Config.METRICS_TOKEN,
			},
		}

		res.set('Content-Type', 'application/json')
		res.send(JSON.stringify(response))
	}

	getApp() {
		return this.app
	}

}
