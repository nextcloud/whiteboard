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
use OCP\AppFramework\ApiController;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;
use Psr\Log\LoggerInterface;

/**
 * @psalm-suppress UndefinedClass
 * @psalm-suppress UndefinedDocblockClass
 */
final class WhiteboardController extends ApiController {
	public function __construct(
		$appName,
		IRequest $request,
		private GetUserFromIdServiceFactory $getUserFromIdServiceFactory,
		private GetFileServiceFactory $getFileServiceFactory,
		private JWTService $jwtService,
		private WhiteboardContentService $contentService,
		private ExceptionService $exceptionService,
		private ConfigService $configService,
		private LoggerInterface $logger,
	) {
		parent::__construct($appName, $request);
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	#[PublicPage]
	public function show(int $fileId): DataResponse {
		try {
			$this->logger->warning('WhiteboardController::show - Request for fileId: ' . $fileId, [
				'file_id' => $fileId,
				'request_params' => $this->request->getParams()
			]);

			$jwt = $this->getJwtFromRequest();

			$this->logger->warning('JWT token retrieved, attempting to extract user ID');

			$userId = $this->jwtService->getUserIdFromJWT($jwt);

			$this->logger->warning('User ID extracted from JWT: ' . $userId);

			try {
				$user = $this->getUserFromIdServiceFactory->create($userId)->getUser();
			} catch (Exception $e) {
				$this->logger->error('Failed to create user object for: ' . $userId, [
					'error' => $e->getMessage()
				]);
				throw $e;
			}

			$this->logger->warning('User object created for: ' . $userId);

			try {
				$file = $this->getFileServiceFactory->create($user, $fileId)->getFile();
			} catch (Exception $e) {
				$this->logger->error('Failed to retrieve file for fileId: ' . $fileId, [
					'error' => $e->getMessage()
				]);
				throw $e;
			}

			$this->logger->warning('File retrieved for fileId: ' . $fileId);

			try {
				$data = $this->contentService->getContent($file);
			} catch (Exception $e) {
				$this->logger->error('Failed to retrieve content for file', [
					'file_id' => $fileId,
					'error' => $e->getMessage()
				]);
				throw $e;
			}

			$this->logger->warning('Content retrieved for file', [
				'file_id' => $fileId,
				'data_size' => is_array($data) ? count($data) : 'not array'
			]);

			$this->logger->warning('Content retrieved for file', [
				'file_id' => $fileId,
				'data_size' => is_array($data) ? count($data) : 'not array'
			]);

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
			$this->logger->warning('WhiteboardController::update - Request for fileId: ' . $fileId, [
				'file_id' => $fileId,
				'request_params' => json_encode(substr(json_encode($this->request->getParams()), 0, 500)) . '...'
			]);

			$this->validateBackendSharedToken($fileId);

			$this->logger->warning('Backend shared token validated for fileId: ' . $fileId);

			$userId = $this->getUserIdFromRequest();

			$this->logger->warning('User ID extracted from request: ' . $userId);

			try {
				$user = $this->getUserFromIdServiceFactory->create($userId)->getUser();
			} catch (Exception $e) {
				$this->logger->error('Failed to create user object for: ' . $userId, [
					'error' => $e->getMessage()
				]);
				throw $e;
			}

			$this->logger->warning('User object created for: ' . $userId);

			try {
				$file = $this->getFileServiceFactory->create($user, $fileId)->getFile();
			} catch (Exception $e) {
				$this->logger->error('Failed to retrieve file for fileId: ' . $fileId, [
					'error' => $e->getMessage()
				]);
				throw $e;
			}

			$this->logger->warning('File retrieved for fileId: ' . $fileId);

			try {
				$this->contentService->updateContent($file, $data);
			} catch (Exception $e) {
				$this->logger->error('Failed to update content for file', [
					'file_id' => $fileId,
					'error' => $e->getMessage()
				]);
				throw $e;
			}

			$this->logger->warning('Content updated for file', [
				'file_id' => $fileId,
				'data_size' => count($data)
			]);

			return new DataResponse(['status' => 'success']);
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
				'token_present' => !empty($backendSharedToken),
				'token_length' => strlen((string)$backendSharedToken)
			]);

			throw new InvalidUserException('Invalid backend shared token');
		}

		$this->logger->warning('Backend shared token validated successfully for fileId: ' . $fileId);
	}

	private function verifySharedToken(string $token, int $fileId): bool {
		[$roomId, $timestamp, $signature] = explode(':', $token);

		if ($roomId !== (string)$fileId) {
			return false;
		} else {
			$this->logger->warning('Room ID matches file ID: ' . $fileId);
		}

		$sharedSecret = $this->configService->getWhiteboardSharedSecret();

		$this->logger->warning('Shared secret retrieved, length: ' . strlen($sharedSecret));

		$payload = "$roomId:$timestamp";
		$expectedSignature = hash_hmac('sha256', $payload, $sharedSecret);

		$this->logger->warning('Token validation', [
			'token_valid' => hash_equals($expectedSignature, $signature)
		]);

		return hash_equals($expectedSignature, $signature);
	}
}
