<?php

declare(strict_types=1);

namespace OCA\Whiteboard\Controller;

use OCP\AppFramework\ApiController;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;
use OCP\IUserSession;

final class WhiteboardController extends ApiController {
	public function __construct(
		$AppName,
		IRequest $request,
		private IUserSession $userSession) {
		parent::__construct($AppName, $request);
	}

	/**
	 * @throws \JsonException
	 */
	public function saveState($roomID, $state) {
		$userId = $this->userSession->getUser()?->getUID();
		$filePath = "/$userId/files/whiteboards/$roomID.json";
		file_put_contents($filePath, json_encode($state, JSON_THROW_ON_ERROR));
		return new DataResponse(['status' => 'success']);
	}

	/**
	 * @throws \JsonException
	 */
	public function loadState($roomID) {
		$userId = $this->userSession->getUser()?->getUID();
		$filePath = "/$userId/files/whiteboards/$roomID.json";
		if (file_exists($filePath)) {
			$state = json_decode(file_get_contents($filePath), true, 512, JSON_THROW_ON_ERROR);
			return new DataResponse($state);
		}
		return new DataResponse(['status' => 'error', 'message' => 'File not found'], 404);
	}
}
