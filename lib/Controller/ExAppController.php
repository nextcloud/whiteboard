<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Controller;

use Exception;
use OCA\AppAPI\Attribute\AppAPIAuth;
use OCA\Whiteboard\Service\ConfigService;
use OCA\Whiteboard\Service\ExceptionService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;

/**
 * @psalm-suppress UndefinedClass
 * @psalm-suppress MissingDependency
 * @psalm-suppress UndefinedAttributeClass
 */
final class ExAppController extends Controller {
	public function __construct(
		IRequest $request,
		private ExceptionService $exceptionService,
		private ConfigService $configService,
	) {
		parent::__construct('whiteboard', $request);
	}

	#[NoCSRFRequired]
	#[PublicPage]
	#[AppAPIAuth]
	public function updateSettings(): DataResponse {
		try {
			$serverUrl = $this->request->getParam('serverUrl');
			$secret = $this->request->getParam('secret');

			if ($serverUrl !== null) {
				$this->configService->setCollabBackendUrl($serverUrl);
			}

			if ($secret !== null) {
				$this->configService->setWhiteboardSharedSecret($secret);
			}

			return new DataResponse([
				'message' => 'Settings updated',
			]);
		} catch (Exception $e) {
			return $this->exceptionService->handleException($e);
		}
	}
}
