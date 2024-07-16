<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use Exception;
use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use OCA\Whiteboard\Consts\JWTConsts;
use OCP\AppFramework\Http;
use OCP\IRequest;
use OCP\IUser;
use OCP\IUserManager;
use OCP\IUserSession;
use RuntimeException;

/**
 * @psalm-suppress UndefinedClass
 */
final class AuthenticationService {
	public function __construct(
		private ConfigService $configService,
		private IUserManager  $userManager,
		private IUserSession  $userSession
	) {
	}

	/**
	 * @throws Exception
	 */
	public function authenticateJWT(IRequest $request): string {
		$authHeader = $request->getHeader('Authorization');
		if (!$authHeader || sscanf($authHeader, 'Bearer %s', $jwt) !== 1) {
			throw new RuntimeException('Unauthorized', Http::STATUS_UNAUTHORIZED);
		}

		if (!is_string($jwt)) {
			throw new RuntimeException('JWT token must be a string', Http::STATUS_BAD_REQUEST);
		}

		try {
			$key = $this->configService->getJwtSecretKey();

			return JWT::decode($jwt, new Key($key, JWTConsts::JWT_ALGORITHM))->userid;
		} catch (Exception) {
			throw new RuntimeException('Unauthorized', Http::STATUS_UNAUTHORIZED);
		}
	}

	/**
	 * @throws Exception
	 */
	public function getAuthenticatedUser(): IUser {
		if (!$this->userSession->isLoggedIn()) {
			throw new RuntimeException('Unauthorized', Http::STATUS_UNAUTHORIZED);
		}

		$user = $this->userSession->getUser();
		if ($user === null) {
			throw new RuntimeException('Unauthorized', Http::STATUS_UNAUTHORIZED);
		}

		return $user;
	}

	/**
	 * @throws Exception
	 */
	public function authenticateSharedToken(IRequest $request, int $fileId): void {
		$whiteboardAuth = $request->getHeader('X-Whiteboard-Auth');
		if (!$whiteboardAuth || !$this->verifySharedToken($whiteboardAuth, $fileId)) {
			throw new RuntimeException('Unauthorized', Http::STATUS_UNAUTHORIZED);
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

	/**
	 * @throws Exception
	 */
	public function getAndSetUser(IRequest $request): IUser {
		$whiteboardUser = $request->getHeader('X-Whiteboard-User');
		$user = $this->userManager->get($whiteboardUser);
		if (!$user) {
			throw new RuntimeException('Invalid user', Http::STATUS_BAD_REQUEST);
		}

		$this->userSession->setVolatileActiveUser($user);

		return $user;
	}
}
