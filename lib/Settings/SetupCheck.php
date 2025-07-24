<?php

declare(strict_types=1);
/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Settings;

use OCA\Whiteboard\Service\ConfigService;
use OCP\IL10N;
use OCP\SetupCheck\SetupResult;

class SetupCheck implements \OCP\SetupCheck\ISetupCheck {
	public function __construct(
		private ConfigService $configService,
		private IL10N $l10n,
	) {
	}
	#[\Override]
	public function getCategory(): string {
		return 'system';
	}

	/**
	 * @inheritDoc
	 */
	#[\Override]
	public function getName(): string {
		return 'Whiteboard real-time collaboration';
	}

	/**
	 * @inheritDoc
	 */
	#[\Override]
	public function run(): \OCP\SetupCheck\SetupResult {
		// Check if the WebSocket server URL is configured
		if ($this->configService->getCollabBackendUrl() === '') {
			return SetupResult::error(
				$this->l10n->t('WebSocket server URL is not configured. Real-time collaboration requires a separate WebSocket server. Basic whiteboard functionality works without it.'),
				'https://github.com/nextcloud/whiteboard?tab=readme-ov-file#websocket-server-for-real-time-collaboration'
			);
		}

		// Check if the shared secret key is configured
		if ($this->configService->getWhiteboardSharedSecret() === '') {
			return SetupResult::error(
				$this->l10n->t('WebSocket server shared secret is not configured. This is required for secure authentication between Nextcloud and the WebSocket server for real-time collaboration.'),
				'https://github.com/nextcloud/whiteboard?tab=readme-ov-file#websocket-server-for-real-time-collaboration'
			);
		}

		// Note: We don't perform server-to-server connectivity checks here because:
		// 1. The whiteboard uses a client-first architecture where browsers connect directly to the websocket server
		// 2. The Nextcloud server might be in a different network environment (Docker, proxy, etc.)
		// 3. The frontend admin UI already performs a browser-based connection test

		return SetupResult::success($this->l10n->t('WebSocket server configuration is valid. Browser-based connection test will verify actual connectivity for real-time collaboration.'));
	}
}
