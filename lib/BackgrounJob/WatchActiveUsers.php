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

class WatchActiveUsers extends TimedJob {
    public function __construct(
        ITimeFactory $time,
        protected bool $isCLI,
        protected StatsService $statsService,
        protected ConfigService $configService,
    ) {
        parent::__construct($time);
        $this->setInterval(300);
    }

    protected function run($argument) {
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

        $curl = curl_init();
        curl_setopt($curl, CURLOPT_URL, $serverUrl . '/metrics');
        curl_setopt($curl, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($curl, CURLOPT_HTTPHEADER, [
            'Authorization: Bearer ' . $metricToken,
        ]);
        $response = curl_exec($curl);
        curl_close($curl);

        $metrics = [
            'totalUsers' => 0,
        ];

        foreach (explode("\n", $response) as $line) {
            if (strpos($line, 'whiteboard_room_stats{stat="totalUsers"}') === false) {
                continue;
            }
            $parts = explode(' ', $line);
            $metrics['totalUsers'] = (int) $parts[1];
        }

        return $metrics;
    }
}
