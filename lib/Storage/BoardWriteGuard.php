<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Storage;

use OC\Files\Filesystem;
use OC\Files\Storage\Wrapper\Wrapper;
use OCA\Whiteboard\Service\BoardSyncService;
use OCP\Files\Storage\IStorage;

/**
 * Checks a board right before Whiteboard writes it, where Nextcloud holds the
 * file's exclusive lock whether it runs file hooks or not
 */
final class BoardWriteGuard extends Wrapper {
	/**
	 * Wraps every storage set up after this, and those already set up
	 *
	 * @psalm-suppress PossiblyUnusedMethod called by the hook
	 */
	public static function register(): void {
		Filesystem::addStorageWrapper('whiteboard', static fn (string $mountPoint, IStorage $storage): IStorage => new self(['storage' => $storage]), -5);
	}

	#[\Override]
	public function file_put_contents(string $path, mixed $data): int|float|false {
		return BoardSyncService::guardOwnWrite($this, $path, fn (): int|float|false => parent::file_put_contents($path, $data));
	}
}
