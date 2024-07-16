<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use Firebase\JWT\JWT;
use OCA\Whiteboard\Consts\JWTConsts;
use OCP\Files\File;
use OCP\Files\InvalidPathException;
use OCP\Files\NotFoundException;
use OCP\IUser;

final class JWTService {
	public function __construct(
		private ConfigService $configService
	) {
	}

	/**
	 * @throws InvalidPathException
	 * @throws NotFoundException
	 */
	public function generateJWT(IUser $user, File $file, int $fileId): string {
		$key = $this->configService->getJwtSecretKey();
		$issuedAt = time();
		$expirationTime = $issuedAt + JWTConsts::EXPIRATION_TIME;
		$payload = [
			'userid' => $user->getUID(),
			'fileId' => $fileId,
			'permissions' => $file->getPermissions(),
			'user' => [
				'id' => $user->getUID(),
				'name' => $user->getDisplayName()
			],
			'iat' => $issuedAt,
			'exp' => $expirationTime
		];

		return JWT::encode($payload, $key, JWTConsts::JWT_ALGORITHM);
	}
}
