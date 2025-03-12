<?php

declare(strict_types=1);
/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Settings;

use OCA\Whiteboard\AppInfo\Application;
use OCA\Whiteboard\Service\ConfigService;
use OCP\App\IAppManager;
use OCP\Http\Client\IClientService;
use OCP\IL10N;
use OCP\SetupCheck\SetupResult;
use Psr\Log\LoggerInterface;

class SetupCheck implements \OCP\SetupCheck\ISetupCheck {
	public function __construct(
		private IClientService $clientService,
		private ConfigService $configService,
		private LoggerInterface $logger,
		private IL10N $l10n,
		private IAppManager $appManager,
	) {
	}
	public function getCategory(): string {
		return 'system';
	}

	/**
	 * @inheritDoc
	 */
	public function getName(): string {
		return 'Whiteboard server';
	}

	/**
	 * @inheritDoc
	 */
	public function run(): \OCP\SetupCheck\SetupResult {
		if ($this->configService->getCollabBackendUrl() === '') {
			return SetupResult::error($this->l10n->t('Whiteboard server URL is not configured. Whiteboard requires a separate collaboration server that is connected to Nextcloud.'), 'https://github.com/nextcloud/whiteboard?tab=readme-ov-file#running-the-server');
		}

		$client = $this->clientService->newClient();
		try {
			$options = [];
			if ($this->configService->getSkipTlsVerify()) {
				$options['verify'] = false;
			}
			$result = $client->get($this->configService->getInternalCollabBackendUrl(), $options);
		} catch (\Exception $e) {
			$this->logger->error('Nextcloud server could not connect to whiteboard server', ['exception' => $e]);

			return SetupResult::error($this->l10n->t('Nextcloud server could not connect to whiteboard server: %s', [$e->getMessage()]));
		}

		try {
			$result = $client->get($this->configService->getInternalCollabBackendUrl() . '/status', $options);
			$resultObject = json_decode((string)$result->getBody(), false, 512, JSON_THROW_ON_ERROR);
			$backendVersion = $resultObject?->version ?? null;

			if ($backendVersion === null) {
				return SetupResult::error($this->l10n->t('No version provided by /status enpdoint'));
			}

			$appVersion = $this->appManager->getAppVersion(Application::APP_ID);
			if (!version_compare($backendVersion, $appVersion, '==')) {
				return SetupResult::warning(
					$this->l10n->t('Backend server is running a different version, make sure to upgrade both to the same version. App: %s Backend version: %s', [$appVersion, $backendVersion])
				);
			}

			if ($resultObject->connectBack !== true) {
				return SetupResult::error(
					$this->l10n->t('Whiteboard backend server could not reach Nextcloud: %s', [$resultObject->connectBack])
				);
			}
		} catch (\Exception $e) {
			$this->logger->error('Failed to connect to whiteboard server status endpoint', ['exception' => $e]);
			return SetupResult::error($this->l10n->t('Failed to connect to whiteboard server status endpoint: %s', [$e->getMessage()]));
		}

		return SetupResult::success($this->l10n->t('Whiteboard server configured properly'));
	}
}
