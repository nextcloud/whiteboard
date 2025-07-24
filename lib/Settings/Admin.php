<?php

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Settings;

use OCA\Whiteboard\Service\ConfigService;
use OCA\Whiteboard\Service\JWTService;
use OCP\AppFramework\Http\ContentSecurityPolicy;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\AppFramework\Services\IInitialState;
use OCP\Settings\ISettings;

class Admin implements ISettings {
	public function __construct(
		private IInitialState $initialState,
		private ConfigService $configService,
		private JWTService $jwtService,
	) {
	}

	#[\Override]
	public function getForm(): TemplateResponse {
		$this->initialState->provideInitialState('url', $this->configService->getCollabBackendUrl());
		$this->initialState->provideInitialState('secret', $this->configService->getWhiteboardSharedSecret());
		$this->initialState->provideInitialState('jwt', $this->jwtService->generateJWTFromPayload([]));
		$this->initialState->provideInitialState('maxFileSize', $this->configService->getMaxFileSize());
		$response = new TemplateResponse(
			'whiteboard',
			'admin',
			[],
			'blank'
		);
		$csp = new ContentSecurityPolicy();
		$csp->addAllowedConnectDomain('*');
		$response->setContentSecurityPolicy($csp);
		return $response;
	}

	#[\Override]
	public function getSection() {
		return 'whiteboard';
	}

	#[\Override]
	public function getPriority() {
		return 0;
	}
}
