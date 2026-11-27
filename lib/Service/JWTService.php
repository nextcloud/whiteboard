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
use OCA\Whiteboard\Exception\UnauthorizedException;
use OCA\Whiteboard\Model\User;
use OCP\Files\File;
use OCP\Files\InvalidPathException;
use OCP\Files\NotFoundException;

final class JWTService {
	public function __construct(
		private ConfigService $configService,
	) {
	}

	/**
	 * @throws InvalidPathException
	 * @throws NotFoundException
	 */
	public function generateJWT(User $user, File $file, bool $isFileReadOnly = true): string {
		$issuedAt = time();
		$expirationTime = $issuedAt + JWTConsts::EXPIRATION_TIME;
		$payload = [
			'userid' => $user->getUID(),
			'fileId' => $file->getId(),
			'isFileReadOnly' => $isFileReadOnly,
			'user' => [
				'id' => $user->getUID(),
				'name' => $user->getDisplayName()
			],
			'iat' => $issuedAt,
			'exp' => $expirationTime
		];

		return $this->generateJWTFromPayload($payload);
	}

	/**
	 * @throws InvalidPathException
	 * @throws NotFoundException
	 */
	public function generateJWTFromPayload(array $payload): string {
		$key = $this->configService->getJwtSecretKey();
		return JWT::encode($payload, $key, JWTConsts::JWT_ALGORITHM);
	}

	public function isReadOnlyJWT(string $jwt): bool {
		try {
			$key = $this->configService->getJwtSecretKey();
			$decoded = JWT::decode($jwt, new Key($key, JWTConsts::JWT_ALGORITHM));

			return (bool)($decoded->isFileReadOnly ?? false);
		} catch (Exception) {
			throw new UnauthorizedException();
		}
	}

	/**
	 * @param int|null $fileId the board the request is about; a token made for another board is refused
	 */
	public function getUserIdFromJWT(string $jwt, ?int $fileId = null): string {
		try {
			$key = $this->configService->getJwtSecretKey();
			$decoded = JWT::decode($jwt, new Key($key, JWTConsts::JWT_ALGORITHM));
		} catch (Exception) {
			throw new UnauthorizedException();
		}
		// Only a token of the board may open it; tokens of the admin settings carry no board and no user
		if ($fileId !== null && (int)($decoded->fileId ?? 0) !== $fileId) {
			throw new UnauthorizedException();
		}
		$userId = $decoded->userid ?? null;
		if (!is_string($userId)) {
			throw new UnauthorizedException();
		}
		return $userId;
	}
}
