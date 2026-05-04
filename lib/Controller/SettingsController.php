<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Controller;

use Exception;
use OCA\Whiteboard\Service\ConfigService;
use OCA\Whiteboard\Service\ExceptionService;
use OCA\Whiteboard\Service\JWTService;
use OCA\Whiteboard\Service\WhiteboardLibraryService;
use OCA\Whiteboard\Settings\SetupCheck;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;
use OCP\IUserSession;

/**
 * @psalm-suppress UndefinedClass
 * @psalm-suppress MissingDependency
 */
final class SettingsController extends Controller {
	public function __construct(
		IRequest $request,
		private ExceptionService $exceptionService,
		private JWTService $jwtService,
		private ConfigService $configService,
		private SetupCheck $setupCheck,
		private IUserSession $userSession,
		private WhiteboardLibraryService $libraryService,
	) {
		parent::__construct('whiteboard', $request);
	}

	public function update(): DataResponse {
		try {
			$serverUrl = $this->request->getParam('serverUrl');
			$secret = $this->request->getParam('secret');
			$maxFileSize = $this->request->getParam('maxFileSize');

			if ($serverUrl !== null) {
				$this->configService->setCollabBackendUrl($serverUrl);
			}

			if ($secret !== null) {
				$this->configService->setWhiteboardSharedSecret($secret);
			}

			if ($maxFileSize !== null) {
				$this->configService->setMaxFileSize(intval($maxFileSize));
			}

			$result = null;
			if ($serverUrl !== null || $secret !== null || $maxFileSize !== null) {
				$result = $this->setupCheck->run();
			}

			return new DataResponse([
				'jwt' => $this->jwtService->generateJWTFromPayload([ 'serverUrl' => $serverUrl ?: $this->configService->getCollabBackendUrl() ]),
				'check' => $result?->jsonSerialize(),
			]);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}

	public function updatePersonal(): DataResponse {
		try {
			$user = $this->userSession->getUser();
			if ($user === null) {
				throw new Exception('User not logged in');
			}

			$autoUploadOnDisconnect = $this->request->getParam('autoUploadOnDisconnect');
			if ($autoUploadOnDisconnect !== null) {
				$normalized = $autoUploadOnDisconnect;
				if (is_string($autoUploadOnDisconnect)) {
					$normalized = filter_var($autoUploadOnDisconnect, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
				}
				$enabled = $normalized === null ? false : (bool)$normalized;
				$this->configService->setUserAutoUploadOnDisconnect($user->getUID(), $enabled);
			}

			return new DataResponse([
				'autoUploadOnDisconnect' => $this->configService->getUserAutoUploadOnDisconnect($user->getUID()),
			]);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}

	public function listGlobalLibraryTemplates(): DataResponse {
		try {
			return new DataResponse($this->libraryService->getGlobalTemplateMetadata());
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}

	public function uploadGlobalLibraryTemplate(): DataResponse {
		try {
			$uploadedFile = $this->request->getUploadedFile('file');
			if (!is_array($uploadedFile) || !isset($uploadedFile['tmp_name'], $uploadedFile['name'])) {
				throw new Exception('No library template uploaded', Http::STATUS_BAD_REQUEST);
			}
			if (($uploadedFile['error'] ?? UPLOAD_ERR_OK) !== UPLOAD_ERR_OK) {
				throw new Exception('Library template upload failed', Http::STATUS_BAD_REQUEST);
			}

			$content = file_get_contents($uploadedFile['tmp_name']);
			if ($content === false) {
				throw new Exception('Failed to read uploaded library template', Http::STATUS_BAD_REQUEST);
			}

			return new DataResponse([
				'template' => $this->libraryService->saveGlobalTemplateFromUpload($uploadedFile['name'], $content),
			], Http::STATUS_CREATED);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}

	public function deleteGlobalLibraryTemplate(string $templateName): DataResponse {
		try {
			$this->libraryService->deleteGlobalTemplate($templateName);
			return new DataResponse(['status' => 'success']);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}
}
