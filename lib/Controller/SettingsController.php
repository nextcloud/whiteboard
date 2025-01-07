<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Controller;

use Exception;
use OCA\Whiteboard\Service\ConfigService;
use OCA\Whiteboard\Service\ExceptionService;
use OCA\Whiteboard\Service\JWTService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;

/**
 * @psalm-suppress UndefinedClass
 * @psalm-suppress MissingDependency
 */
final class SettingsController extends Controller {
	public function __construct(
		IRequest $request,
		private ExceptionService $exceptionService,
		private JWTService $jwtService,
		private ConfigService $configService,
	) {
		parent::__construct('whiteboard', $request);
	}

	public function update(): DataResponse {
		try {
			$serverUrl = $this->request->getParam('serverUrl');
			$secret = $this->request->getParam('secret');
			$maxFileSize = $this->request->getParam('maxFileSize');

			if ($serverUrl !== null) {
				$this->configService->setCollabBackendUrl($serverUrl);
			}

			if ($secret !== null) {
				$this->configService->setWhiteboardSharedSecret($secret);
			}

			if ($maxFileSize !== null) {
				$this->configService->setMaxFileSize(intval($maxFileSize));
			}

			return new DataResponse([
				'jwt' => $this->jwtService->generateJWTFromPayload([ 'serverUrl' => $serverUrl ])
			]);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}
}
