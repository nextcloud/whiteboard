<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

use OCA\Whiteboard\Controller\JWTController;
use OCA\Whiteboard\Controller\SettingsController;
use OCA\Whiteboard\Controller\StatsController;
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
		/** @see StatsController::summary() */
		['name' => 'StatsController#summary', 'url' => 'stats/summary', 'verb' => 'GET'],
		/** @see StatsController::getActiveUsersCount() */
		['name' => 'StatsController#getActiveUsersCount', 'url' => 'stats/active-users-count', 'verb' => 'GET'],
		/** @see StatsController::getStoredBoardsCount() */
		['name' => 'StatsController#getStoredBoardsCount', 'url' => 'stats/boards-count', 'verb' => 'GET'],
		/** @see StatsController::getUsersStoredBoards() */
		['name' => 'StatsController#getUsersStoredBoards', 'url' => 'stats/user-boards', 'verb' => 'GET'],
		/** @see StatsController::getBoardsInfo() */
		['name' => 'StatsController#getBoardsInfo', 'url' => 'stats/boards-info', 'verb' => 'GET'],
	]
];
