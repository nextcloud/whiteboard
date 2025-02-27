<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Controller;

use Exception;
use OCA\Whiteboard\Events\WhiteboardOpenedEvent;
use OCA\Whiteboard\Events\WhiteboardUpdatedEvent;
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
use OCP\EventDispatcher\IEventDispatcher;
use OCP\IRequest;

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
		private IEventDispatcher $dispatcher,
	) {
		parent::__construct($appName, $request);
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

			$event = new WhiteboardOpenedEvent($file, $user, $data);
			$this->dispatcher->dispatchTyped($event);

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
			$this->validateBackendSharedToken($fileId);

			$userId = $this->getUserIdFromRequest();

			$user = $this->getUserFromIdServiceFactory->create($userId)->getUser();

			$file = $this->getFileServiceFactory->create($user, $fileId)->getFile();

			$this->contentService->updateContent($file, $data);

			$event = new WhiteboardUpdatedEvent($file, $user, $data);
			$this->dispatcher->dispatchTyped($event);

			return new DataResponse(['status' => 'success']);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}

	private function getJwtFromRequest(): string {
		$authHeader = $this->request->getHeader('Authorization');
		if (sscanf($authHeader, 'Bearer %s', $jwt) !== 1) {
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
