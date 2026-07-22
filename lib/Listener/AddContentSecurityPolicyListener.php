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
	private const EXCALIDRAW_LIBRARY_ORIGIN = 'https://libraries.excalidraw.com';

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

		if (!$this->isWhiteboardPage()) {
			return;
		}

		$policy = new EmptyContentSecurityPolicy();
		$policy->addAllowedWorkerSrcDomain('\'self\'');
		if (!$this->configService->getDisableExternalLibraries()) {
			$policy->addAllowedConnectDomain(self::EXCALIDRAW_LIBRARY_ORIGIN);
		}

		foreach ($this->configService->getCollabBackendCspConnectDomains() as $domain) {
			$policy->addAllowedConnectDomain($domain);
		}

		$event->addPolicy($policy);
	}

	private function isWhiteboardPage(): bool {
		if ($this->request->getMethod() !== 'GET') {
			return false;
		}

		$pathInfo = $this->request->getPathInfo();
		if (!is_string($pathInfo)) {
			return false;
		}

		$pathInfo = $this->normalizePathInfo($pathInfo);

		// The /apps/files prefix also covers non-page GET endpoints. Keep this
		// listener scoped to page shells that can host Whiteboard instead of adding
		// Whiteboard collaboration sources to Files API responses or service workers.
		if ($this->pathMatches($pathInfo, '/apps/files/api')
			|| $this->pathMatches($pathInfo, '/apps/files/preview-service-worker.js')) {
			return false;
		}

		return $this->pathMatches($pathInfo, '/apps/files')
			|| $this->pathMatches($pathInfo, '/apps/whiteboard/recording')
			|| $this->pathMatches($pathInfo, '/apps/spreed')
			|| $this->pathMatches($pathInfo, '/call')
			|| $this->pathMatches($pathInfo, '/f')
			|| $this->pathMatches($pathInfo, '/s');
	}

	private function normalizePathInfo(string $pathInfo): string {
		$path = parse_url($pathInfo, PHP_URL_PATH);
		if (is_string($path)) {
			$pathInfo = $path;
		}

		if ($pathInfo === '/index.php') {
			return '/';
		}

		if (str_starts_with($pathInfo, '/index.php/')) {
			return substr($pathInfo, strlen('/index.php'));
		}

		return $pathInfo;
	}

	private function pathMatches(string $pathInfo, string $prefix): bool {
		return $pathInfo === $prefix || str_starts_with($pathInfo, $prefix . '/');
	}
}
