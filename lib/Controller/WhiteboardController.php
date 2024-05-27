<?php

declare(strict_types=1);

namespace OCA\Whiteboard\Controller;

use OC\Files\Node\File;
use OC\User\NoUserException;
use OCP\App\AppPathNotFoundException;
use OCP\App\IAppManager;
use OCP\AppFramework\ApiController;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\DataResponse;
use OCP\Files\IRootFolder;
use OCP\Files\NotPermittedException;
use OCP\IRequest;
use OCP\IUserSession;

final class WhiteboardController extends ApiController {

	public function __construct($appName, IRequest $request, private readonly IUserSession $userSession, private readonly IRootFolder $rootFolder) {
		parent::__construct($appName, $request);
	}

	#[NoAdminRequired]
	public function update(int $fileId, array $state): DataResponse {
		$user = $this->userSession->getUser();
		$userFolder = $this->rootFolder->getUserFolder($user?->getUID());
		$file = $userFolder->getById($fileId)[0];

		$file->putContent(json_encode($state, JSON_THROW_ON_ERROR));

		return new DataResponse(['status' => 'success']);
	}

	/**
	 * @throws AppPathNotFoundException
	 * @throws \JsonException
	 */
	#[NoAdminRequired]
	#[NoCSRFRequired]
	#[PublicPage]
	public function show(int $fileId): DataResponse {
		$appPath = $this->appManager->getAppPath($this->appName);

		$filePath = $appPath . "/files/$fileId.json";

		if (!file_exists($filePath)) {
			return new DataResponse(['status' => 'error', 'message' => 'File not found'], 404);
		}

		$state = json_decode(file_get_contents($filePath), true, 512, JSON_THROW_ON_ERROR);

		return new DataResponse($state);
	}
}
