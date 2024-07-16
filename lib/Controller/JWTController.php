<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Controller;

use OCA\Whiteboard\Service\AuthenticationService;
use OCA\Whiteboard\Service\ExceptionService;
use OCA\Whiteboard\Service\FileService;
use OCA\Whiteboard\Service\JWTService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;

/**
 * @psalm-suppress UndefinedClass
 * @psalm-suppress MissingDependency
 */
final class JWTController extends Controller {
	public function __construct(
		IRequest                      $request,
		private AuthenticationService $authService,
		private FileService           $fileService,
		private JWTService            $jwtService,
		private ExceptionService      $exceptionService
	) {
		parent::__construct('whiteboard', $request);
	}

	/**
	 * @NoCSRFRequired
	 * @NoAdminRequired
	 */
	public function getJWT(int $fileId): DataResponse {
		try {
			$user = $this->authService->getAuthenticatedUser();
			$file = $this->fileService->getUserFileById($user->getUID(), $fileId);
			$jwt = $this->jwtService->generateJWT($user, $file, $fileId);
			return new DataResponse(['token' => $jwt]);
		} catch (\Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}
}
