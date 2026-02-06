<?php

/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Settings;

use OCA\Whiteboard\Service\ConfigService;
use OCP\AppFramework\Http\ContentSecurityPolicy;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\AppFramework\Services\IInitialState;
use OCP\IUserSession;
use OCP\Settings\ISettings;

/**
 * @psalm-suppress UnusedClass
 */
class Personal implements ISettings {
	public function __construct(
		private IInitialState $initialState,
		private ConfigService $configService,
		private IUserSession $userSession,
	) {
	}

	#[\Override]
	public function getForm(): TemplateResponse {
		$user = $this->userSession->getUser();
		$autoUploadOnDisconnect = $user
			? $this->configService->getUserAutoUploadOnDisconnect($user->getUID())
			: false;
		$this->initialState->provideInitialState('autoUploadOnDisconnect', $autoUploadOnDisconnect);

		$response = new TemplateResponse(
			'whiteboard',
			'personal',
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
