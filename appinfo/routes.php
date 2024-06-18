<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

use OCA\Whiteboard\Controller\WhiteboardController;

return [
	'routes' => [
		/** @see JWTController::getJWT() */
		['name' => 'JWT#getJWT', 'url' => '{fileId}/token', 'verb' => 'GET'],
		/** @see WhiteboardController::update() */
		['name' => 'Whiteboard#update', 'url' => '{fileId}', 'verb' => 'PUT'],
		/** @see WhiteboardController::show() */
		['name' => 'Whiteboard#show', 'url' => '{fileId}', 'verb' => 'GET'],
	]
];
