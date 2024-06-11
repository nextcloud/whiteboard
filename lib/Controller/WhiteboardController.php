<?php

declare(strict_types=1);

namespace OCA\Whiteboard\Controller;

use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use OC\User\NoUserException;
use OCP\AppFramework\ApiController;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\DataResponse;
use OCP\Files\IRootFolder;
use OCP\Files\NotPermittedException;
use OCP\IConfig;
use OCP\IRequest;
use OCP\IUserSession;

final class WhiteboardController extends ApiController {

	public function __construct(
		$appName,
		IRequest $request,
		private readonly IUserSession $userSession,
		private readonly IRootFolder $rootFolder,
		private readonly IConfig $config
	) {
		parent::__construct($appName, $request);
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	#[PublicPage]
	public function update(int $fileId, array $data): DataResponse {
		$user = $this->userSession->getUser();
		$userFolder = $this->rootFolder->getUserFolder($user?->getUID());
		$file = $userFolder->getById($fileId)[0];

		$file->putContent(json_encode($data, JSON_THROW_ON_ERROR));

		return new DataResponse(['status' => 'success']);
	}

	/**
	 * @throws NotPermittedException
	 * @throws NoUserException
	 * @throws \JsonException
	 */
	#[NoAdminRequired]
	#[NoCSRFRequired]
	#[PublicPage]
	public function show(int $fileId): DataResponse {
		$authHeader = $this->request->getHeader('Authorization');

		if (!$authHeader) {
			return new DataResponse(['message' => 'Unauthorized'], Http::STATUS_UNAUTHORIZED);
		}

		[$jwt] = sscanf($authHeader, 'Bearer %s');

		if (!$jwt) {
			return new DataResponse(['message' => 'Unauthorized'], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$key = $this->config->getSystemValueString('jwt_secret_key');
			$decoded = JWT::decode($jwt, new Key($key, 'HS256'));
			$userId = $decoded->userid;
		} catch (\Exception $e) {
			return new DataResponse(['message' => 'Unauthorized'], Http::STATUS_UNAUTHORIZED);
		}

		$userFolder = $this->rootFolder->getUserFolder($userId);
		$file = $userFolder->getById($fileId)[0];

		$data = json_decode($file->getContent(), true, 512, JSON_THROW_ON_ERROR);

		return new DataResponse([
			'data' => $data,
		]);
	}
}
