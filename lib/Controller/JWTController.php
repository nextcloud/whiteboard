<?php

declare(strict_types=1);

namespace OCA\Whiteboard\Controller;

use Firebase\JWT\JWT;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\DataResponse;
use OCP\IConfig;
use OCP\IRequest;
use OCP\IUserSession;

final class JWTController extends Controller {
	private const EXPIRATION_TIME = 15 * 60;

	private const JWT_CONFIG_KEY = 'jwt_secret_key';

	private const JWT_ALGORITHM = 'HS256';

	public function __construct(
		IRequest                      $request,
		private readonly IUserSession $userSession,
		private readonly IConfig      $config
	) {
		parent::__construct('whiteboard', $request);
	}

	/**
	 * @NoCSRFRequired
	 * @NoAdminRequired
	 */
	public function getJWT(): DataResponse {
		if (!$this->userSession->isLoggedIn()) {
			return new DataResponse(['message' => 'Unauthorized'], Http::STATUS_UNAUTHORIZED);
		}

		$user = $this->userSession->getUser();

		if ($user === null) {
			return new DataResponse(['message' => 'Unauthorized'], Http::STATUS_UNAUTHORIZED);
		}

		$userId = $user->getUID();

		$key = $this->config->getSystemValueString(self::JWT_CONFIG_KEY);
		$issuedAt = time();
		$expirationTime = $issuedAt + self::EXPIRATION_TIME;
		$payload = [
			'userid' => $userId,
			'iat' => $issuedAt,
			'exp' => $expirationTime
		];

		$jwt = JWT::encode($payload, $key, self::JWT_ALGORITHM);

		return new DataResponse(['token' => $jwt]);
	}
}
