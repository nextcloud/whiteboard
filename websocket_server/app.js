/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import express from 'express'

const app = express()

app.get('/', (req, res) => {
	res.send('Excalidraw collaboration server is up :)')
})

export default app
