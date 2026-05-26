<?php

declare(strict_types=1);
/**
 * SPDX-FileCopyrightText: 2022 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Listener;

use OCA\Whiteboard\Service\ConfigService;
use OCP\AppFramework\Http\EmptyContentSecurityPolicy;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\IRequest;
use OCP\Security\CSP\AddContentSecurityPolicyEvent;

/** @template-implements IEventListener<Event|AddContentSecurityPolicyEvent> */
class AddContentSecurityPolicyListener implements IEventListener {
	public function __construct(
		private IRequest $request,
		private ConfigService $configService,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if (!$event instanceof AddContentSecurityPolicyEvent) {
			return;
		}

		if (!$this->isPageLoad() || !$this->isWhiteboardPage()) {
			return;
		}

		$domains = $this->configService->getCollabBackendCspConnectDomains();
		if ($domains === []) {
			return;
		}

		$policy = new EmptyContentSecurityPolicy();
		foreach ($domains as $domain) {
			$policy->addAllowedConnectDomain($domain);
		}

		$event->addPolicy($policy);
	}

	private function isPageLoad(): bool {
		$scriptNameParts = explode('/', $this->request->getScriptName());
		return end($scriptNameParts) === 'index.php';
	}

	private function isWhiteboardPage(): bool {
		$pathInfo = $this->request->getPathInfo();
		if (!is_string($pathInfo)) {
			return false;
		}

		return str_starts_with($pathInfo, '/apps/files')
			|| str_starts_with($pathInfo, '/apps/whiteboard/recording')
			|| str_starts_with($pathInfo, '/s/');
	}
}
