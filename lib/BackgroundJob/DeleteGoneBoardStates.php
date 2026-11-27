<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\BackgroundJob;

use OCA\Whiteboard\Service\BoardStateStore;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\TimedJob;

/**
 * Drops once a day the sync state of boards whose file is gone
 *
 * @psalm-suppress UnusedClass registered in appinfo/info.xml
 */
final class DeleteGoneBoardStates extends TimedJob {
	public function __construct(
		ITimeFactory $time,
		private BoardStateStore $states,
	) {
		parent::__construct($time);
		$this->setInterval(24 * 3600);
		$this->setTimeSensitivity(self::TIME_INSENSITIVE);
	}

	#[\Override]
	protected function run($argument): void {
		$this->states->deleteGone();
	}
}
