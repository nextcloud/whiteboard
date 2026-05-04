<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Controller;

use Exception;
use OCA\Whiteboard\Service\CanvasTemplateService;
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
		private CanvasTemplateService $canvasTemplateService,
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

	public function listOrgLibraries(): DataResponse {
		try {
			return new DataResponse(['libraries' => $this->libraryService->listLibraries($this->uid())['org']]);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}

	public function uploadOrgLibrary(): DataResponse {
		try {
			$uploadedFile = $this->request->getUploadedFile('file');
			if (!is_array($uploadedFile) || !isset($uploadedFile['tmp_name'], $uploadedFile['name'])) {
				throw new Exception('No library uploaded', Http::STATUS_BAD_REQUEST);
			}
			if (($uploadedFile['error'] ?? UPLOAD_ERR_OK) !== UPLOAD_ERR_OK) {
				throw new Exception('Library upload failed', Http::STATUS_BAD_REQUEST);
			}

			$content = file_get_contents($uploadedFile['tmp_name']);
			if ($content === false) {
				throw new Exception('Failed to read uploaded library', Http::STATUS_BAD_REQUEST);
			}

			$name = (string)preg_replace('/\.excalidrawlib$/i', '', (string)$uploadedFile['name']);
			$items = $this->libraryService->parseLibraryFile($content);

			return new DataResponse([
				'library' => $this->libraryService->saveLibrary($this->uid(), 'org', $name, $items),
			], Http::STATUS_CREATED);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}

	public function deleteOrgLibrary(string $name): DataResponse {
		try {
			$this->libraryService->deleteLibrary($this->uid(), 'org', $name);
			return new DataResponse(['status' => 'success']);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}

	public function listOrgCanvasTemplates(): DataResponse {
		try {
			return new DataResponse(['canvasTemplates' => $this->canvasTemplateService->listOrgCanvasTemplates()]);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}

	public function uploadOrgCanvasTemplate(): DataResponse {
		try {
			$uploadedFile = $this->request->getUploadedFile('file');
			if (!is_array($uploadedFile) || !isset($uploadedFile['tmp_name'], $uploadedFile['name'])) {
				throw new Exception('No canvas uploaded', Http::STATUS_BAD_REQUEST);
			}
			if (($uploadedFile['error'] ?? UPLOAD_ERR_OK) !== UPLOAD_ERR_OK) {
				throw new Exception('Canvas upload failed', Http::STATUS_BAD_REQUEST);
			}

			$content = file_get_contents($uploadedFile['tmp_name']);
			if ($content === false) {
				throw new Exception('Failed to read uploaded canvas', Http::STATUS_BAD_REQUEST);
			}

			$name = (string)preg_replace('/\.whiteboard$/i', '', (string)$uploadedFile['name']);
			$data = $this->canvasTemplateService->parseCanvasTemplateData($content);

			return new DataResponse([
				'canvasTemplate' => $this->canvasTemplateService->publishCanvasTemplate($this->uid(), 'org', $name, $data),
			], Http::STATUS_CREATED);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}

	public function deleteOrgCanvasTemplate(string $name): DataResponse {
		try {
			$this->canvasTemplateService->deleteOrgCanvasTemplate($name);
			return new DataResponse(['status' => 'success']);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}

	private function uid(): string {
		return $this->userSession->getUser()?->getUID() ?? '';
	}
}
