<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Controller;

use InvalidArgumentException;
use OC\User\NoUserException;
use OCA\Whiteboard\Consts\RecordingConsts;
use OCA\Whiteboard\Model\User;
use OCA\Whiteboard\Service\Authentication\AuthenticateUserServiceFactory;
use OCA\Whiteboard\Service\ConfigService;
use OCA\Whiteboard\Service\File\GetFileServiceFactory;
use OCA\Whiteboard\Service\JWTService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\ContentSecurityPolicy;
use OCP\AppFramework\Http\JSONResponse;
use OCP\AppFramework\Http\Response;
use OCP\AppFramework\Http\Template\PublicTemplateResponse;
use OCP\AppFramework\Services\IInitialState;
use OCP\Files\InvalidPathException;
use OCP\Files\IRootFolder;
use OCP\Files\Node;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;
use OCP\IRequest;
use OCP\IURLGenerator;
use OCP\Util;
use RuntimeException;
use Throwable;

/**
 * @psalm-suppress MissingDependency
 * @psalm-suppress PossiblyInvalidArgument
 * @psalm-suppress UndefinedInterfaceMethod
 * @psalm-suppress UndefinedDocblockClass
 * @psalm-suppress ArgumentTypeCoercion
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
		private IURLGenerator $urlGenerator,
	) {
		parent::__construct('whiteboard', $request);
	}

	/**
	 * @NoCSRFRequired
	 * @NoAdminRequired
	 * @PublicPage
	 */
	public function recording(int $fileId, string $userId): Http\TemplateResponse {
		try {
			$sharedToken = $this->validateSharedToken();
			$user = $this->authenticateRecordingAgent($fileId, $userId, $sharedToken);
			$jwt = $this->generateRecordingJWT($user, $fileId);

			$this->initializeRecordingState($fileId, $jwt);
			return $this->createRecordingResponse();
		} catch (Throwable $e) {
			return new Http\TemplateResponse($this->appName, 'recording', [], Http\TemplateResponse::RENDER_AS_BLANK);
		}
	}

	/**
	 * @NoCSRFRequired
	 * @NoAdminRequired
	 * @PublicPage
	 */
	public function upload(int $fileId, string $userId): Response {
		try {
			$sharedToken = $this->validateSharedToken();
			$user = $this->authenticateRecordingAgent($fileId, $userId, $sharedToken);
			$fileService = $this->getFileServiceFactory->create($user, $fileId);

			$uploadedFile = $this->validateUploadedFile();
			$recordingsFolder = $this->getOrCreateRecordingsFolder($userId);

			$filename = $this->generateRecordingFilename($fileService->getFile()->getName() ?: $fileId);
			$content = $this->readUploadedFileContent($uploadedFile);

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

	private function validateSharedToken(): string {
		$sharedToken = $this->request->getParam('token');
		if (!$sharedToken) {
			throw new InvalidArgumentException('Shared token is required');
		}
		return $sharedToken;
	}

	private function authenticateRecordingAgent(int $fileId, string $userId, string $sharedToken): User {
		$recordingParams = [
			'fileId' => (string)$fileId,
			'userId' => $userId,
			'sharedToken' => $sharedToken,
		];
		return $this->authenticateUserServiceFactory->create(null, $recordingParams)->authenticate();
	}

	/**
	 * @throws NotFoundException
	 * @throws InvalidPathException
	 */
	private function generateRecordingJWT($user, int $fileId): string {
		$fileService = $this->getFileServiceFactory->create($user, $fileId);
		$file = $fileService->getFile();
		return $this->jwtService->generateJWT($user, $file);
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
	 * @throws NoUserException
	 * @throws NotFoundException
	 */
	private function getOrCreateRecordingsFolder(string $userId): Node {
		$userFolder = $this->rootFolder->getUserFolder($userId);
		if (!$userFolder->nodeExists(RecordingConsts::RECORDINGS_FOLDER)) {
			$userFolder->newFolder(RecordingConsts::RECORDINGS_FOLDER);
		}
		return $userFolder->get(RecordingConsts::RECORDINGS_FOLDER);
	}

	private function generateRecordingFilename(string $filename): string {
		$sanitizedName = preg_replace('/[^a-zA-Z0-9_\- ]/', '_', pathinfo($filename, PATHINFO_FILENAME));
		return sprintf('%s (%s).webm', $sanitizedName, date('Y-m-d H:i'));
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
