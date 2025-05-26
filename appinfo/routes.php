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
		/** @see WhiteboardController::getLib() */
		['name' => 'Whiteboard#getLib', 'url' => 'library', 'verb' => 'GET'],
		/** @see WhiteboardController::updateLib() */
		['name' => 'Whiteboard#updateLib', 'url' => 'library', 'verb' => 'PUT'],
		/** @see WhiteboardController::update() */
		['name' => 'Whiteboard#update', 'url' => '{fileId}', 'verb' => 'PUT'],
		/** @see WhiteboardController::show() */
		['name' => 'Whiteboard#show', 'url' => '{fileId}', 'verb' => 'GET'],
		/** @see SettingsController::update() */
		['name' => 'Settings#update', 'url' => 'settings', 'verb' => 'POST'],
	]
];
