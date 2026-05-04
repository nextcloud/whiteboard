<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Controller;

use Exception;
use InvalidArgumentException;
use OCA\Whiteboard\Exception\InvalidUserException;
use OCA\Whiteboard\Exception\UnauthorizedException;
use OCA\Whiteboard\Service\Authentication\GetUserFromIdServiceFactory;
use OCA\Whiteboard\Service\CanvasTemplateService;
use OCA\Whiteboard\Service\ConfigService;
use OCA\Whiteboard\Service\ExceptionService;
use OCA\Whiteboard\Service\File\GetFileServiceFactory;
use OCA\Whiteboard\Service\JWTService;
use OCA\Whiteboard\Service\WhiteboardContentService;
use OCA\Whiteboard\Service\WhiteboardLibraryService;
use OCP\AppFramework\ApiController;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\DataResponse;
use OCP\ICacheFactory;
use OCP\IGroupManager;
use OCP\IMemcache;
use OCP\IRequest;
use Psr\Log\LoggerInterface;

/**
 * @psalm-suppress UndefinedClass
 * @psalm-suppress UndefinedDocblockClass
 */
final class WhiteboardController extends ApiController {
	private IMemcache $cache;

	public function __construct(
		$appName,
		IRequest $request,
		private GetUserFromIdServiceFactory $getUserFromIdServiceFactory,
		private GetFileServiceFactory $getFileServiceFactory,
		private JWTService $jwtService,
		private WhiteboardContentService $contentService,
		private WhiteboardLibraryService $libraryService,
		private CanvasTemplateService $canvasTemplateService,
		private ExceptionService $exceptionService,
		private ConfigService $configService,
		private LoggerInterface $logger,
		private ICacheFactory $cacheFactory,
		private IGroupManager $groupManager,
	) {
		parent::__construct($appName, $request);
		$this->cache = $cacheFactory->createLocking('whiteboard_sync');
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	#[PublicPage]
	public function show(int $fileId): DataResponse {
		try {
			$jwt = $this->getJwtFromRequest();
			$userId = $this->jwtService->getUserIdFromJWT($jwt);
			$user = $this->getUserFromIdServiceFactory->create($userId)->getUser();
			$file = $this->getFileServiceFactory->create($user, $fileId)->getFile();
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
		$lockKey = "sync_lock_{$fileId}";
		$lockValue = uniqid();
		$lockTTL = 5; // 5 seconds

		// Simple distributed lock
		if (!$this->cache->add($lockKey, $lockValue, $lockTTL)) {
			return new DataResponse(['status' => 'conflict'], 409);
		}

		try {
			$jwt = $this->getJwtFromRequest();
			$userId = $this->jwtService->getUserIdFromJWT($jwt);
			$user = $this->getUserFromIdServiceFactory->create($userId)->getUser();
			$file = $this->getFileServiceFactory->create($user, $fileId)->getFile();

			$this->contentService->updateContent($file, $data);

			return new DataResponse(['status' => 'success']);
		} catch (Exception $e) {
			$this->logger->error('Error syncing whiteboard data: ' . $e->getMessage());
			return $this->exceptionService->handleException($e);
		} finally {
			if ($this->cache->get($lockKey) === $lockValue) {
				$this->cache->remove($lockKey);
			}
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
