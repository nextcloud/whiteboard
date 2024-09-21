<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Controller;

use Exception;
use OCA\Whiteboard\Service\Authentication\AuthenticateUserServiceFactory;
use OCA\Whiteboard\Service\ExceptionService;
use OCA\Whiteboard\Service\File\GetFileServiceFactory;
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
		IRequest                               $request,
		private GetFileServiceFactory          $getFileServiceFactory,
		private JWTService                     $jwtService,
		private ExceptionService               $exceptionService,
		private AuthenticateUserServiceFactory $authenticateUserServiceFactory,
	) {
		parent::__construct('whiteboard', $request);
	}

	/**
	 * @NoCSRFRequired
	 * @NoAdminRequired
	 * @PublicPage
	 */
	public function getJWT(int $fileId): DataResponse {
		try {
			$publicSharingToken = $this->request->getParam('publicSharingToken');

			$user = $this->authenticateUserServiceFactory->create($publicSharingToken)->authenticate();

			$fileService = $this->getFileServiceFactory->create($user, $fileId);

			$file = $fileService->getFile();

			$isFileReadOnly = $fileService->isFileReadOnly();

			$jwt = $this->jwtService->generateJWT($user, $file, $isFileReadOnly);

			return new DataResponse(['token' => $jwt]);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}
}
