<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Controller;

use Exception;
use OCA\Whiteboard\Service\AuthenticationService;
use OCA\Whiteboard\Service\ExceptionService;
use OCA\Whiteboard\Service\FileService;
use OCA\Whiteboard\Service\WhiteboardContentService;
use OCP\AppFramework\ApiController;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;

/**
 * @psalm-suppress UndefinedClass
 * @psalm-suppress UndefinedDocblockClass
 */
final class WhiteboardController extends ApiController {
	public function __construct(
		$appName,
		IRequest $request,
		private AuthenticationService $authService,
		private FileService $fileService,
		private WhiteboardContentService $contentService,
		private ExceptionService $exceptionService
	) {
		parent::__construct($appName, $request);
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	#[PublicPage]
	public function show(int $fileId): DataResponse {
		try {
			$userId = $this->authService->authenticateJWT($this->request);
			$file = $this->fileService->getUserFileById($userId, $fileId);
			$data = $this->contentService->getContent($file);
			return new DataResponse(['data' => $data]);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	#[PublicPage]
	public function update(int $fileId, array $data): DataResponse {
		try {
			$this->authService->authenticateSharedToken($this->request, $fileId);
			$user = $this->authService->getAndSetUser($this->request);
			$file = $this->fileService->getUserFileById($user->getUID(), $fileId);
			$this->contentService->updateContent($file, $data);
			return new DataResponse(['status' => 'success']);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}
}
