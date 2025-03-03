/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import express from 'express'
import axios from 'axios'

export default class AppManager {

	constructor() {
		this.app = express()
		this.setupRoutes()
	}

	setupRoutes() {
		this.app.get('/', this.homeHandler.bind(this))
		this.app.get('/status', this.statusHandler.bind(this))
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

	getApp() {
		return this.app
	}

}
