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
		return 'Whiteboard collaboration server';
	}

	/**
	 * @inheritDoc
	 */
	#[\Override]
	public function run(): \OCP\SetupCheck\SetupResult {
		if ($this->configService->getCollabBackendUrl() === '') {
			return SetupResult::info(
				$this->l10n->t('Boards are saved to Nextcloud. Real-time collaboration (seeing each other\'s changes and cursors live) needs the Whiteboard collaboration server, which is not configured.'),
				'https://github.com/nextcloud/whiteboard?tab=readme-ov-file#websocket-server'
			);
		}

		if ($this->configService->getWhiteboardSharedSecret() === '') {
			return SetupResult::error(
				$this->l10n->t('The Whiteboard collaboration server is configured without a shared secret, so it cannot authenticate users and real-time collaboration does not work. Boards are still saved to Nextcloud.'),
				'https://github.com/nextcloud/whiteboard?tab=readme-ov-file#websocket-server'
			);
		}

		// Browsers connect to the collaboration server directly; the admin page tests that connection from the browser
		return SetupResult::success($this->l10n->t('The Whiteboard collaboration server is configured. The admin settings test the connection from your browser.'));
	}
}
