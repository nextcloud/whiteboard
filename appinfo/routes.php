<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

use OCA\Whiteboard\Controller\AiController;
use OCA\Whiteboard\Controller\JWTController;
use OCA\Whiteboard\Controller\PickerController;
use OCA\Whiteboard\Controller\RecordingController;
use OCA\Whiteboard\Controller\SettingsController;
use OCA\Whiteboard\Controller\WhiteboardController;

return [
	'routes' => [
		/** @see AiController::tagFile() */
		['name' => 'Ai#tagFile', 'url' => 'ai/tag/{fileId}', 'verb' => 'POST'],
		/** @see JWTController::getJWT() */
		['name' => 'JWT#getJWT', 'url' => '{fileId}/token', 'verb' => 'GET'],
		/** @see WhiteboardController::getLib() */
		['name' => 'Whiteboard#getLib', 'url' => 'library', 'verb' => 'GET'],
		/** @see WhiteboardController::updateLib() */
		['name' => 'Whiteboard#updateLib', 'url' => 'library', 'verb' => 'PUT'],
		/** @see WhiteboardController::listLibraries() */
		['name' => 'Whiteboard#listLibraries', 'url' => 'libraries', 'verb' => 'GET'],
		/** @see WhiteboardController::resolveLibrary() */
		['name' => 'Whiteboard#resolveLibrary', 'url' => 'libraries/resolve', 'verb' => 'GET'],
		/** @see WhiteboardController::saveLibrary() */
		['name' => 'Whiteboard#saveLibrary', 'url' => 'libraries', 'verb' => 'POST'],
		/** @see WhiteboardController::deleteLibrary() */
		['name' => 'Whiteboard#deleteLibrary', 'url' => 'libraries/{scope}/{name}', 'verb' => 'DELETE'],
		/** @see WhiteboardController::publishCanvasTemplate() */
		['name' => 'Whiteboard#publishCanvasTemplate', 'url' => 'canvas-template', 'verb' => 'POST'],
		/** @see PickerController::index() */
		['name' => 'Picker#index', 'url' => 'picker', 'verb' => 'GET'],
		/** @see WhiteboardController::update() */
		['name' => 'Whiteboard#update', 'url' => '{fileId}', 'verb' => 'PUT'],
		/** @see WhiteboardController::show() */
		['name' => 'Whiteboard#show', 'url' => '{fileId}', 'verb' => 'GET'],
		/** @see RecordingController::recording() */
		['name' => 'Recording#recording', 'url' => 'recording/{fileId}/{userId}', 'verb' => 'GET'],
		/** @see RecordingController::upload() */
		['name' => 'Recording#upload', 'url' => 'recording/{fileId}/upload', 'verb' => 'POST'],
		/** @see SettingsController::update() */
		['name' => 'Settings#update', 'url' => 'settings', 'verb' => 'POST'],
		/** @see SettingsController::updatePersonal() */
		['name' => 'Settings#updatePersonal', 'url' => 'settings/personal', 'verb' => 'POST'],
		/** @see SettingsController::listOrgLibraries() */
		['name' => 'Settings#listOrgLibraries', 'url' => 'settings/org-library', 'verb' => 'GET'],
		/** @see SettingsController::uploadOrgLibrary() */
		['name' => 'Settings#uploadOrgLibrary', 'url' => 'settings/org-library', 'verb' => 'POST'],
		/** @see SettingsController::deleteOrgLibrary() */
		['name' => 'Settings#deleteOrgLibrary', 'url' => 'settings/org-library/{name}', 'verb' => 'DELETE'],
		/** @see SettingsController::listOrgCanvasTemplates() */
		['name' => 'Settings#listOrgCanvasTemplates', 'url' => 'settings/org-canvas-template', 'verb' => 'GET'],
		/** @see SettingsController::uploadOrgCanvasTemplate() */
		['name' => 'Settings#uploadOrgCanvasTemplate', 'url' => 'settings/org-canvas-template', 'verb' => 'POST'],
		/** @see SettingsController::deleteOrgCanvasTemplate() */
		['name' => 'Settings#deleteOrgCanvasTemplate', 'url' => 'settings/org-canvas-template/{name}', 'verb' => 'DELETE'],
	]
];
