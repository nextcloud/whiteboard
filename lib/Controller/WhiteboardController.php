<?php

declare(strict_types=1);
/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Controller;

use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use OC\User\NoUserException;
use OCA\Whiteboard\Service\ConfigService;
use OCP\AppFramework\ApiController;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\DataResponse;
use OCP\Files\IRootFolder;
use OCP\Files\NotPermittedException;
use OCP\IRequest;
use OCP\IUserSession;

/**
 * @psalm-suppress UndefinedClass
 * @psalm-suppress UndefinedDocblockClass
 */
final class WhiteboardController extends ApiController {
	public function __construct(
		$appName,
		IRequest $request,
		private IUserSession $userSession,
		private IRootFolder $rootFolder,
		private ConfigService $configService
	) {
		parent::__construct($appName, $request);
	}

	/**
	 * @throws NotPermittedException
	 * @throws NoUserException
	 * @throws \JsonException
	 */
	#[NoAdminRequired]
	#[NoCSRFRequired]
	#[PublicPage]
	public function update(int $fileId, array $data): DataResponse {
		$user = $this->userSession->getUser();
		$userFolder = $this->rootFolder->getUserFolder($user?->getUID());
		$file = $userFolder->getById($fileId)[0];

		if (empty($data)) {
			$data = ['elements' => [], 'scrollToContent' => true];
		}

		$file->putContent(json_encode($data, JSON_THROW_ON_ERROR));

		return new DataResponse(['status' => 'success']);
	}

	/**
	 * @throws NotPermittedException
	 * @throws NoUserException
	 * @throws \JsonException
	 */
	#[NoAdminRequired]
	#[NoCSRFRequired]
	#[PublicPage]
	public function show(int $fileId): DataResponse {
		$authHeader = $this->request->getHeader('Authorization');

		if (!$authHeader) {
			return new DataResponse(['message' => 'Unauthorized'], Http::STATUS_UNAUTHORIZED);
		}

		$assignedValues = sscanf($authHeader, 'Bearer %s', $jwt);

		if (!$assignedValues) {
			return new DataResponse(['message' => 'Unauthorized'], Http::STATUS_UNAUTHORIZED);
		}

		if (!$jwt || !is_string($jwt)) {
			return new DataResponse(['message' => 'Unauthorized'], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$key = $this->configService->getJwtSecretKey();
			$decoded = JWT::decode($jwt, new Key($key, JWTController::JWT_ALGORITHM));
			$userId = $decoded->userid;
		} catch (\Exception $e) {
			return new DataResponse(['message' => 'Unauthorized'], Http::STATUS_UNAUTHORIZED);
		}

		$userFolder = $this->rootFolder->getUserFolder($userId);
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
