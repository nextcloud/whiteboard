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

class PruneOldStatisticsData extends TimedJob {
	public function __construct(
		ITimeFactory $time,
		protected bool $isCLI,
		protected StatsService $statsService,
		protected ConfigService $configService,
	) {
		parent::__construct($time);
		$this->setInterval(24 * 60 * 60);
	}

	protected function run($argument) {
		$lifeTimeInDays = $this->configService->getStatisticsDataLifetime();

		if (!$lifeTimeInDays) {
			return;
		}

		$beforeTime = time() - $lifeTimeInDays * 24 * 60 * 60;
		$this->statsService->pruneData($beforeTime);
	}
}
