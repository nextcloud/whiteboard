<?php

declare(strict_types=1);
/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
namespace OCA\Whiteboard\Controller;

use OCP\AppFramework\ApiController;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\DataResponse;
use OCP\Files\IRootFolder;
use OCP\IRequest;
use OCP\IUserSession;

final class WhiteboardController extends ApiController {

	public function __construct($appName, IRequest $request, private readonly IUserSession $userSession, private readonly IRootFolder $rootFolder) {
		parent::__construct($appName, $request);
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	public function update(int $fileId, array $data): DataResponse {
		$user = $this->userSession->getUser();
		$userFolder = $this->rootFolder->getUserFolder($user?->getUID());
		$file = $userFolder->getById($fileId)[0];

		$file->putContent(json_encode($data, JSON_THROW_ON_ERROR));

		return new DataResponse(['status' => 'success']);
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	public function show(int $fileId): DataResponse {
		$user = $this->userSession->getUser();
		$userFolder = $this->rootFolder->getUserFolder($user?->getUID());
		$file = $userFolder->getById($fileId)[0];

		$fileContent = $file->getContent();
		if ($fileContent === '') {
			$fileContent = '{"elements":[],"scrollToContent":true}';
		}
		$data = json_decode($fileContent, true, 512, JSON_THROW_ON_ERROR);

		return new DataResponse([
			'data' => $data,
		]);
	}
}
