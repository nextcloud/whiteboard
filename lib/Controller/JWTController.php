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
	public function __construct(
		IRequest $request,
		private readonly IUserSession $userSession,
		private readonly IConfig $config
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

		$key = $this->config->getSystemValueString('jwt_secret_key');
		$issuedAt = time();
		$expirationTime = $issuedAt + 3600;
		$payload = [
			'userid' => $userId,
			'iat' => $issuedAt,
			'exp' => $expirationTime
		];

		$jwt = JWT::encode($payload, $key, 'HS256');

		return new DataResponse(['token' => $jwt]);
	}
}
