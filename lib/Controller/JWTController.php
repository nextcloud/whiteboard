<?php

declare(strict_types=1);
/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Controller;

use Firebase\JWT\JWT;
use OC\User\NoUserException;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\DataResponse;
use OCP\Files\InvalidPathException;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;
use OCP\IConfig;
use OCP\IRequest;
use OCP\IUserSession;

/**
 * @psalm-suppress UndefinedClass
 * @psalm-suppress MissingDependency
 */
final class JWTController extends Controller {
	private const EXPIRATION_TIME = 15 * 60;

	private const JWT_CONFIG_KEY = 'jwt_secret_key';

	private const JWT_ALGORITHM = 'HS256';

	public function __construct(
		IRequest                      $request,
		private IUserSession $userSession,
		private IConfig      $config,
		private IRootFolder  $rootFolder
	) {
		parent::__construct('whiteboard', $request);
	}

	/**
	 * @NoCSRFRequired
	 * @NoAdminRequired
	 */
	public function getJWT(int $fileId): DataResponse {
		if (!$this->userSession->isLoggedIn()) {
			return new DataResponse(['message' => 'Unauthorized'], Http::STATUS_UNAUTHORIZED);
		}

		$user = $this->userSession->getUser();

		if ($user === null) {
			return new DataResponse(['message' => 'Unauthorized'], Http::STATUS_UNAUTHORIZED);
		}

		$userId = $user->getUID();
		try {
			$folder = $this->rootFolder->getUserFolder($userId);
		} catch (NotPermittedException $e) {
			return new DataResponse(['message' => 'Access denied'], Http::STATUS_FORBIDDEN);
		} catch (NoUserException $e) {
			return new DataResponse(['message' => 'Unauthorized'], Http::STATUS_UNAUTHORIZED);
		}

		$file = $folder->getById($fileId)[0] ?? null;

		if ($file === null) {
			return new DataResponse(['message' => 'File not found or access denied'], Http::STATUS_FORBIDDEN);
		}

		try {
			$readable = $file->isReadable();
		} catch (InvalidPathException|NotFoundException $e) {
			return new DataResponse(['message' => 'Access denied'], Http::STATUS_FORBIDDEN);
		}

		if (!$readable) {
			return new DataResponse(['message' => 'Access denied'], Http::STATUS_FORBIDDEN);
		}

		try {
			$permissions = $file->getPermissions();
		} catch (InvalidPathException $e) {
			return new DataResponse(['message' => 'Access denied'], Http::STATUS_FORBIDDEN);
		} catch (NotFoundException $e) {
			return new DataResponse(['message' => 'File not found'], Http::STATUS_NOT_FOUND);
		}

		$key = $this->config->getSystemValueString(self::JWT_CONFIG_KEY);
		$issuedAt = time();
		$expirationTime = $issuedAt + self::EXPIRATION_TIME;
		$payload = [
			'userid' => $userId,
			'fileId' => $fileId,
			'permissions' => $permissions,
			'user' => [
				'id' => $userId,
				'name' => $user->getDisplayName()
			],
			'iat' => $issuedAt,
			'exp' => $expirationTime
		];

		$jwt = JWT::encode($payload, $key, self::JWT_ALGORITHM);

		return new DataResponse(['token' => $jwt]);
	}
}
