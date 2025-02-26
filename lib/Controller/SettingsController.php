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
use OCA\Whiteboard\Settings\SetupCheck;
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
		private SetupCheck $setupCheck,
	) {
		parent::__construct('whiteboard', $request);
	}

	public function update(): DataResponse {
		try {
			$serverUrl = $this->request->getParam('serverUrl');
			$serverUrlInternal = $this->request->getParam('serverUrlInternal');
			$secret = $this->request->getParam('secret');
			$maxFileSize = $this->request->getParam('maxFileSize');
			$skipTlsVerify = $this->request->getParam('skipTlsVerify');

			if ($serverUrl !== null) {
				$this->configService->setCollabBackendUrl($serverUrl);
			}

			if ($serverUrlInternal !== null) {
				$this->configService->setInternalCollabBackendUrl($serverUrlInternal);
			}

			if ($secret !== null) {
				$this->configService->setWhiteboardSharedSecret($secret);
			}

			if ($maxFileSize !== null) {
				$this->configService->setMaxFileSize(intval($maxFileSize));
			}

			if ($skipTlsVerify !== null) {
				$this->configService->setSkipTlsVerify(filter_var($skipTlsVerify, FILTER_VALIDATE_BOOLEAN));
			}

			$result = null;
			if ($serverUrl !== null || $serverUrlInternal !== null || $secret !== null || $maxFileSize !== null || $skipTlsVerify !== null) {
				$result = $this->setupCheck->run();
			}

			return new DataResponse([
				'jwt' => $this->jwtService->generateJWTFromPayload([ 'serverUrl' => $serverUrl ?: $this->configService->getCollabBackendUrl() ]),
				'check' => $result?->jsonSerialize(),
			]);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}
}
