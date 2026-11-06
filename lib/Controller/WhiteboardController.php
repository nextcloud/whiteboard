<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Controller;

use Exception;
use InvalidArgumentException;
use OCA\Whiteboard\Exception\BoardBusyException;
use OCA\Whiteboard\Exception\BoardReplacedException;
use OCA\Whiteboard\Exception\BoardUnreadableException;
use OCA\Whiteboard\Exception\InvalidUserException;
use OCA\Whiteboard\Exception\UnauthorizedException;
use OCA\Whiteboard\Model\BoardState;
use OCA\Whiteboard\Service\Authentication\GetUserFromIdServiceFactory;
use OCA\Whiteboard\Service\BoardSyncService;
use OCA\Whiteboard\Service\CanvasTemplateService;
use OCA\Whiteboard\Service\ConfigService;
use OCA\Whiteboard\Service\ExceptionService;
use OCA\Whiteboard\Service\File\GetFileServiceFactory;
use OCA\Whiteboard\Service\JWTService;
use OCA\Whiteboard\Service\WhiteboardLibraryService;
use OCP\AppFramework\ApiController;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\DataResponse;
use OCP\Files\NotPermittedException;
use OCP\IGroupManager;
use OCP\IRequest;
use Psr\Log\LoggerInterface;

/**
 * @psalm-suppress UndefinedClass
 * @psalm-suppress UndefinedDocblockClass
 */
final class WhiteboardController extends ApiController {
	private const SCHEMA_VERSION = 3;

	public function __construct(
		$appName,
		IRequest $request,
		private GetUserFromIdServiceFactory $getUserFromIdServiceFactory,
		private GetFileServiceFactory $getFileServiceFactory,
		private JWTService $jwtService,
		private BoardSyncService $boardSync,
		private WhiteboardLibraryService $libraryService,
		private CanvasTemplateService $canvasTemplateService,
		private ExceptionService $exceptionService,
		private ConfigService $configService,
		private LoggerInterface $logger,
		private IGroupManager $groupManager,
	) {
		parent::__construct($appName, $request);
	}

	/**
	 * The board with its epoch and revision; with `epoch` and `since`, only
	 * what changed after that revision while the epoch is the same
	 */
	#[NoAdminRequired]
	#[NoCSRFRequired]
	#[PublicPage]
	public function show(int $fileId, ?string $epoch = null, ?int $since = null): DataResponse {
		try {
			$jwt = $this->getJwtFromRequest();
			$userId = $this->jwtService->getUserIdFromJWT($jwt);
			$user = $this->getUserFromIdServiceFactory->create($userId)->getUser();
			$file = $this->getFileServiceFactory->create($user, $fileId)->getFile();

			return new DataResponse($this->boardSync->read($file, $epoch, $since));
		} catch (Exception $e) {
			return $this->handleBoardException($e);
		}
	}

	/**
	 * Merges the changed elements and files of a client into the board and
	 * returns what changed after the client's revision
	 */
	#[NoAdminRequired]
	#[NoCSRFRequired]
	#[PublicPage]
	public function update(int $fileId, array $data, array $sync = []): DataResponse {
		try {
			[$user, $file] = $this->getWritableBoard($fileId);
		} catch (Exception $e) {
			return $this->handleBoardException($e);
		}

		// Clients that send whole scenes without an epoch can replace newer
		// boards, so their writes are refused
		if ($this->request->getParam('schemaVersion') !== self::SCHEMA_VERSION) {
			return new DataResponse(['status' => 'error', 'code' => 'client_upgrade_required'], Http::STATUS_BAD_REQUEST);
		}

		try {
			$elements = is_array($data['elements'] ?? null) ? $data['elements'] : [];
			$files = is_array($data['files'] ?? null) ? $data['files'] : [];
			$epoch = is_string($sync['epoch'] ?? null) ? $sync['epoch'] : '';
			$since = is_int($sync['since'] ?? null) ? $sync['since'] : 0;

			return new DataResponse($this->boardSync->save($file, $epoch, $since, $elements, $files, $user, ($sync['repair'] ?? false) === true));
		} catch (Exception $e) {
			return $this->handleBoardException($e);
		}
	}

	/**
	 * Replaces the board with a version and starts a new epoch
	 */
	#[NoAdminRequired]
	#[NoCSRFRequired]
	#[PublicPage]
	public function restore(int $fileId, array $data): DataResponse {
		try {
			[, $file] = $this->getWritableBoard($fileId);
		} catch (Exception $e) {
			return $this->handleBoardException($e);
		}

		if ($this->request->getParam('schemaVersion') !== self::SCHEMA_VERSION) {
			return new DataResponse(['status' => 'error', 'code' => 'client_upgrade_required'], Http::STATUS_BAD_REQUEST);
		}

		try {
			return new DataResponse($this->boardSync->replace($file, $data));
		} catch (Exception $e) {
			return $this->handleBoardException($e);
		}
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	#[PublicPage]
	public function getLib(): DataResponse {
		try {
			$jwt = $this->getJwtFromRequest();
			$userId = $this->jwtService->getUserIdFromJWT($jwt);
			$data = $this->libraryService->getUserLib($userId);

			return new DataResponse(['data' => $data]);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	#[PublicPage]
	public function updateLib(): DataResponse {
		try {
			$jwt = $this->getJwtFromRequest();
			$userId = $this->jwtService->getUserIdFromJWT($jwt);
			$items = $this->request->getParam('items', []);
			$this->libraryService->updateUserLib($userId, $items);

			return new DataResponse(['status' => 'success']);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	#[PublicPage]
	public function listLibraries(): DataResponse {
		try {
			$jwt = $this->getJwtFromRequest();
			$userId = $this->jwtService->getUserIdFromJWT($jwt);
			return new DataResponse(['data' => $this->libraryService->listLibraries($userId)]);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	#[PublicPage]
	public function resolveLibrary(): DataResponse {
		try {
			$jwt = $this->getJwtFromRequest();
			$userId = $this->jwtService->getUserIdFromJWT($jwt);
			$scope = (string)$this->request->getParam('scope', '');
			$name = (string)$this->request->getParam('name', '');
			return new DataResponse(['data' => $this->libraryService->resolveLibrary($userId, $scope, $name)]);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	#[PublicPage]
	public function saveLibrary(): DataResponse {
		try {
			$jwt = $this->getJwtFromRequest();
			$userId = $this->jwtService->getUserIdFromJWT($jwt);
			$scope = (string)$this->request->getParam('scope', 'personal');
			$name = (string)$this->request->getParam('name', '');
			$items = $this->request->getParam('items', []);
			if (!is_array($items)) {
				throw new InvalidArgumentException('Invalid library items', Http::STATUS_BAD_REQUEST);
			}
			if ($scope === 'org' && !$this->groupManager->isAdmin($userId)) {
				throw new InvalidArgumentException('Only administrators can save organization libraries', Http::STATUS_FORBIDDEN);
			}
			return new DataResponse(['library' => $this->libraryService->saveLibrary($userId, $scope, $name, $items)]);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	#[PublicPage]
	public function deleteLibrary(string $scope, string $name): DataResponse {
		try {
			$jwt = $this->getJwtFromRequest();
			$userId = $this->jwtService->getUserIdFromJWT($jwt);
			if ($scope === 'org' && !$this->groupManager->isAdmin($userId)) {
				throw new InvalidArgumentException('Only administrators can delete organization libraries', Http::STATUS_FORBIDDEN);
			}
			$this->libraryService->deleteLibrary($userId, $scope, $name);
			return new DataResponse(['status' => 'success']);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	#[PublicPage]
	public function publishCanvasTemplate(): DataResponse {
		try {
			$jwt = $this->getJwtFromRequest();
			$userId = $this->jwtService->getUserIdFromJWT($jwt);
			$scope = (string)$this->request->getParam('scope', 'personal');
			$name = (string)$this->request->getParam('name', '');
			$data = $this->request->getParam('data');
			if (!is_array($data)) {
				throw new InvalidArgumentException('Invalid canvas template data', Http::STATUS_BAD_REQUEST);
			}
			if ($scope === 'org' && !$this->groupManager->isAdmin($userId)) {
				throw new InvalidArgumentException('Only administrators can publish organization canvas templates', Http::STATUS_FORBIDDEN);
			}
			$parsed = $this->canvasTemplateService->parseCanvasTemplateData($data);
			return new DataResponse(
				['canvasTemplate' => $this->canvasTemplateService->publishCanvasTemplate($userId, $scope, $name, $parsed)],
				Http::STATUS_CREATED
			);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}

	/**
	 * @return array{0: \OCA\Whiteboard\Model\User, 1: \OCP\Files\File}
	 */
	private function getWritableBoard(int $fileId): array {
		$jwt = $this->getJwtFromRequest();
		$userId = $this->jwtService->getUserIdFromJWT($jwt);
		$user = $this->getUserFromIdServiceFactory->create($userId)->getUser();
		$fileService = $this->getFileServiceFactory->create($user, $fileId);
		$file = $fileService->getFile();
		if ($fileService->isFileReadOnly() || $this->jwtService->isReadOnlyJWT($jwt)) {
			throw new NotPermittedException('Permission denied');
		}
		return [$user, $file];
	}

	private function handleBoardException(Exception $e): DataResponse {
		return match (true) {
			$e instanceof BoardReplacedException => new DataResponse(['code' => 'board_replaced', 'sync' => $this->sync($e->state)], Http::STATUS_CONFLICT),
			$e instanceof BoardUnreadableException => new DataResponse(['code' => 'board_unreadable', 'sync' => $this->sync($e->state)], Http::STATUS_CONFLICT),
			$e instanceof BoardBusyException => new DataResponse(['code' => 'busy'], Http::STATUS_SERVICE_UNAVAILABLE, ['Retry-After' => '2']),
			default => $this->exceptionService->handleException($e),
		};
	}

	/**
	 * @return array{epoch: string, rev: int}
	 */
	private function sync(BoardState $state): array {
		return ['epoch' => $state->epoch, 'rev' => $state->rev];
	}

	private function getJwtFromRequest(): string {
		$authHeader = $this->request->getHeader('Authorization');
		if (sscanf($authHeader, 'Bearer %s', $jwt) !== 1) {
			$this->logger->error('Invalid JWT format in Authorization header');
			throw new UnauthorizedException();
		}
		return (string)$jwt;
	}

	private function getUserIdFromRequest(): string {
		return $this->request->getHeader('X-Whiteboard-User');
	}

	private function validateBackendSharedToken(int $fileId): void {
		$backendSharedToken = $this->request->getHeader('X-Whiteboard-Auth');
		if (!$backendSharedToken || !$this->verifySharedToken($backendSharedToken, $fileId)) {
			$this->logger->error('Invalid backend shared token', [
				'file_id' => $fileId,
				'token_present' => !empty($backendSharedToken)
			]);
			throw new InvalidUserException('Invalid backend shared token');
		}
	}

	private function verifySharedToken(string $token, int $fileId): bool {
		[$roomId, $timestamp, $signature] = explode(':', $token);

		if ($roomId !== (string)$fileId) {
			return false;
		}

		$sharedSecret = $this->configService->getWhiteboardSharedSecret();
		$payload = "$roomId:$timestamp";
		$expectedSignature = hash_hmac('sha256', $payload, $sharedSecret);

		return hash_equals($expectedSignature, $signature);
	}
}
