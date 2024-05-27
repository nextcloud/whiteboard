<?php

use OCA\Whiteboard\Controller\WhiteboardController;

return [
	'routes' => [
		/** @see WhiteboardController::update() */
		['name' => 'Whiteboard#update', 'url' => '{fileId}', 'verb' => 'PUT'],
		/** @see WhiteboardController::show() */
		['name' => 'Whiteboard#show', 'url' => '{fileId}', 'verb' => 'GET'],
	]
];
