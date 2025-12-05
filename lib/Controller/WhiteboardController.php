<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Controller;

use Exception;
use OCA\Whiteboard\Exception\InvalidUserException;
use OCA\Whiteboard\Exception\UnauthorizedException;
use OCA\Whiteboard\Service\Authentication\GetUserFromIdServiceFactory;
use OCA\Whiteboard\Service\ConfigService;
use OCA\Whiteboard\Service\ExceptionService;
use OCA\Whiteboard\Service\File\GetFileServiceFactory;
use OCA\Whiteboard\Service\JWTService;
use OCA\Whiteboard\Service\WhiteboardContentService;
use OCA\Whiteboard\Service\WhiteboardLibraryService;
use OCP\AppFramework\ApiController;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\DataResponse;
use OCP\ICacheFactory;
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
		private ExceptionService $exceptionService,
		private ConfigService $configService,
		private LoggerInterface $logger,
		private ICacheFactory $cacheFactory,
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
			$this->jwtService->getUserIdFromJWT($jwt);
			$data = $this->libraryService->getUserLib();

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
    public function getSvgmoji(string $hexcode): void
    {
        $file = file_get_contents(__DIR__ . '/../../img/svgmoji/' . $hexcode . '.svg');

        if (false === $file) {
            header('HTTP/1.1 404 Not Found');
            exit;
        }

        // Detect gzip-compressed SVG (svgz) by gzip magic bytes 0x1F 0x8B 0x08
        $isGzip = (substr($file, 0, 3) === "\x1f\x8b\x08");

        header('Content-Type: image/svg+xml');
        if ($isGzip) {
            header('Content-Encoding: gzip');
        }
        header('Content-Length: ' . strlen($file));

        echo $file;
        exit;
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
