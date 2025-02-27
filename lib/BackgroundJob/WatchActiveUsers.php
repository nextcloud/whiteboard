<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\BackgroundJob;

use OCA\Whiteboard\Service\ConfigService;
use OCA\Whiteboard\Service\StatsService;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\TimedJob;
use OCP\Http\Client\IClientService;

class WatchActiveUsers extends TimedJob {
	public function __construct(
		ITimeFactory $time,
		protected bool $isCLI,
		protected StatsService $statsService,
		protected ConfigService $configService,
		protected IClientService $clientService,
	) {
		parent::__construct($time);
		$this->setInterval(300);
	}

	protected function run($argument) {
		if (!$this->configService->getWhiteboardEnableStatistics()) {
			return;
		}
		$metricsData = $this->getMetricsData();
		$activeUsers = $metricsData['totalUsers'] ?? 0;
		$this->statsService->insertActiveUsersCount($activeUsers);
	}

	private function getMetricsData(): array {
		$serverUrl = $this->configService->getCollabBackendUrl();
		$metricToken = $this->configService->getCollabBackendMetricsToken();

		if (!$serverUrl || !$metricToken) {
			return [];
		}

		$client = $this->clientService->newClient();
		$response = $client->get($serverUrl . '/metrics', [
			'headers' => [
				'Accept' => 'application/json',
				'Content-Type' => 'application/json',
				'Authorization' => 'Bearer ' . $metricToken,
			],
		]);
		$responseBody = $response->getBody();

		$metrics = [
			'totalUsers' => 0
		];

		if (!is_string($responseBody)) {
			return $metrics;
		}

		foreach (explode("\n", $responseBody) as $line) {
			if (strpos($line, 'socket_io_connected') === false) {
				continue;
			}
			$parts = explode(' ', $line);
			$metrics['totalUsers'] = (int)$parts[1];
		}

		return $metrics;
	}
}
