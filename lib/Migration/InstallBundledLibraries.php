<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Migration;

use OCA\Whiteboard\Service\WhiteboardLibraryService;
use OCP\Migration\IOutput;
use OCP\Migration\IRepairStep;

/** @psalm-suppress UnusedClass */
final class InstallBundledLibraries implements IRepairStep {
	public function __construct(
		private WhiteboardLibraryService $libraryService,
	) {
	}

	#[\Override]
	public function getName(): string {
		return 'Add the bundled whiteboard libraries as organization libraries';
	}

	#[\Override]
	public function run(IOutput $output): void {
		$this->libraryService->syncBundledLibraries(true);
	}
}
