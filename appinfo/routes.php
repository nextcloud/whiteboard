<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

use OCA\Whiteboard\Controller\JWTController;
use OCA\Whiteboard\Controller\SettingsController;
use OCA\Whiteboard\Controller\WhiteboardController;

return [
	'routes' => [
		/** @see JWTController::getJWT() */
		['name' => 'JWT#getJWT', 'url' => '{fileId}/token', 'verb' => 'GET'],
		/** @see WhiteboardController::update() */
		['name' => 'Whiteboard#update', 'url' => '{fileId}', 'verb' => 'PUT'],
		/** @see WhiteboardController::show() */
		['name' => 'Whiteboard#show', 'url' => '{fileId}', 'verb' => 'GET'],
		/** @see SettingsController::update() */
		['name' => 'Settings#update', 'url' => 'settings', 'verb' => 'POST'],
		/** @see RecordingController::recording() */
		['name' => 'Recording#recording', 'url' => 'recording/{fileId}/{userId}', 'verb' => 'GET'],
		/** @see RecordingController::upload() */
		['name' => 'Recording#upload', 'url' => 'recording/{fileId}/{userId}/upload', 'verb' => 'POST'],
	]
];
