<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Controller;

use InvalidArgumentException;

use OCA\Whiteboard\Service\Authentication\AuthenticateUserServiceFactory;
use OCA\Whiteboard\Service\ConfigService;
use OCA\Whiteboard\Service\File\GetFileServiceFactory;
use OCA\Whiteboard\Service\JWTService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\ContentSecurityPolicy;
use OCP\AppFramework\Http\JSONResponse;
use OCP\AppFramework\Http\Template\PublicTemplateResponse;
use OCP\AppFramework\Services\IInitialState;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;
use OCP\IDateTimeZone;
use OCP\IRequest;
use OCP\IURLGenerator;
use OCP\Util;
use Psr\Log\LoggerInterface;
use RuntimeException;
use Throwable;

/**
 * @psalm-suppress MissingDependency
 * @psalm-suppress PossiblyInvalidArgument
 * @psalm-suppress UndefinedInterfaceMethod
 * @psalm-suppress UndefinedDocblockClass
 * @psalm-suppress ArgumentTypeCoercion
 * @psalm-suppress UnusedClass
 */
final class RecordingController extends Controller {
	public function __construct(
		IRequest $request,
		private IInitialState $initialState,
		private ConfigService $configService,
		private AuthenticateUserServiceFactory $authenticateUserServiceFactory,
		private GetFileServiceFactory $getFileServiceFactory,
		private JWTService $jwtService,
		private IRootFolder $rootFolder,
		private IDateTimeZone $dateTimeZone,
		private IURLGenerator $urlGenerator,
		private LoggerInterface $logger,
	) {
		parent::__construct('whiteboard', $request);
	}

	/**
	 * @NoCSRFRequired
	 * @NoAdminRequired
	 * @PublicPage
	 * @return PublicTemplateResponse|Http\TemplateResponse
	 */
	public function recording(int $fileId, string $userId) {
		try {
			$jwt = $this->validateJWTToken();
			$jwtUserId = $this->jwtService->getUserIdFromJWT($jwt);

			// Verify the JWT user matches the URL user
			if ($jwtUserId !== $userId) {
				throw new InvalidArgumentException('JWT user does not match URL user');
			}

			$this->initializeRecordingState($fileId, $jwt);
			return $this->createRecordingResponse();
		} catch (Throwable $e) {
			$this->logger->error($e);
			return new Http\TemplateResponse($this->appName, 'recording', [], Http\TemplateResponse::RENDER_AS_BLANK);
		}
	}



	/**
	 * @NoCSRFRequired
	 * @NoAdminRequired
	 * @PublicPage
	 */
	public function upload(int $fileId): JSONResponse {
		try {
			// Only authenticated users should use this endpoint
			$uploadToken = $this->validateUploadToken();
			$userId = $this->jwtService->getUserIdFromJWT($uploadToken);

			// Authenticate user and validate file access
			$user = $this->authenticateUserServiceFactory->create(null)->authenticate();
			$fileService = $this->getFileServiceFactory->create($user, $fileId);

			$uploadedFile = $this->validateUploadedFile();
			$content = $this->readUploadedFileContent($uploadedFile);

			$recordingsFolder = $this->getOrCreateRecordingsFolder($userId);
			$filename = $this->generateRecordingFilename($fileService->getFile()->getName() ?: $fileId);

			$file = $recordingsFolder->newFile($filename, $content);

			return new JSONResponse([
				'status' => 'success',
				'filename' => $filename,
				'fileUrl' => $this->urlGenerator->linkToRouteAbsolute('files.viewcontroller.showFile', ['fileid' => $file->getId()]),
			]);
		} catch (InvalidArgumentException $e) {
			return $this->handleError($e, Http::STATUS_BAD_REQUEST);
		} catch (Throwable $e) {
			return $this->handleError($e, Http::STATUS_INTERNAL_SERVER_ERROR);
		}
	}

	private function validateJWTToken(): string {
		$jwt = $this->request->getParam('token');
		if (!$jwt) {
			throw new InvalidArgumentException('JWT token is required');
		}
		return $jwt;
	}

	private function validateUploadToken(): string {
		$authHeader = $this->request->getHeader('Authorization');
		if (!$authHeader || !str_starts_with($authHeader, 'Bearer ')) {
			throw new InvalidArgumentException('Upload token is required');
		}
		return substr($authHeader, 7); // Remove "Bearer " prefix
	}

	private function initializeRecordingState(int $fileId, string $jwt): void {
		$this->initialState->provideInitialState('isRecording', true);
		$this->initialState->provideInitialState('file_id', $fileId);
		$this->initialState->provideInitialState('jwt', $jwt);
		$this->initialState->provideInitialState('collabBackendUrl', $this->configService->getCollabBackendUrl());
	}

	private function createRecordingResponse(): PublicTemplateResponse {
		$csp = new ContentSecurityPolicy();
		$csp->allowEvalScript();

		$response = new PublicTemplateResponse($this->appName, 'recording');
		$response->setFooterVisible();
		$response->setContentSecurityPolicy($csp);
		$response->cacheFor(0);

		Util::addScript('whiteboard', 'whiteboard-main');
		Util::addStyle('whiteboard', 'whiteboard-main');

		return $response;
	}

	private function validateUploadedFile(): array {
		$uploadedFile = $this->request->getUploadedFile('recording');
		if ($uploadedFile === null || !isset($uploadedFile['tmp_name'])) {
			throw new InvalidArgumentException('No recording file uploaded');
		}
		return $uploadedFile;
	}



	/**
	 * @throws NotPermittedException
	 * @throws NotFoundException
	 */
	private function getOrCreateRecordingsFolder(string $userId): Folder {
		$recordingsFolder = 'Whiteboard Recordings';
		$userFolder = $this->rootFolder->getUserFolder($userId);
		if (!$userFolder->nodeExists($recordingsFolder)) {
			$userFolder->newFolder($recordingsFolder);
		}
		$node = $userFolder->get($recordingsFolder);
		if (!$node instanceof Folder) {
			throw new RuntimeException('Recordings folder is not a folder');
		}
		return $node;
	}

	private function generateRecordingFilename(string $filename): string {
		$sanitizedName = preg_replace('/[^a-zA-Z0-9_\- ]/', '_', pathinfo($filename, PATHINFO_FILENAME)) ?: 'recording';
		$timestamp = (new \DateTimeImmutable('now', $this->dateTimeZone->getTimeZone(time())))
			->format('Y-m-d H-i');
		return sprintf('%s (%s).webm', $sanitizedName, $timestamp);
	}

	private function readUploadedFileContent(array $uploadedFile): string {
		$content = file_get_contents($uploadedFile['tmp_name']);
		if ($content === false) {
			throw new RuntimeException('Failed to read uploaded file');
		}
		return $content;
	}

	private function handleError(Throwable $e, int $status): JSONResponse {
		return new JSONResponse([
			'status' => 'error',
			'message' => $e->getMessage(),
		], $status);
	}
}
