<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Model;

/**
 * The save state of a board. `digest` is the SHA-256 of the bytes the state
 * was last brought in line with: Whiteboard's last write, or the bytes an
 * epoch began with; `pendingDigest` is set while a write is on its way.
 */
final class BoardState {
	// `outside_write` of the row: someone else wrote the file since Whiteboard last did, and whether it was a version restore
	public const OUTSIDE_NONE = 0;
	public const OUTSIDE_WRITE = 1;
	public const OUTSIDE_RESTORE = 2;

	public function __construct(
		public readonly int $fileId,
		public readonly string $epoch,
		public readonly int $rev,
		public readonly string $digest,
		public readonly ?string $etag,
		public readonly ?string $pendingDigest,
		public readonly ?int $pendingAt,
		public readonly bool $outsideWrite,
		/** The outside write was a version restore */
		public readonly bool $restoreWrite = false,
		/** The epoch began with a version restore */
		public readonly bool $restored = false,
		/** How often an outside write was noted */
		public readonly int $outsideCount = 0,
	) {
	}

	/**
	 * What clients know of the state: the epoch, the revision and whether the epoch began with a version restore
	 *
	 * @return array{epoch: string, rev: int, restored: bool}
	 */
	public function toSync(): array {
		return ['epoch' => $this->epoch, 'rev' => $this->rev, 'restored' => $this->restored];
	}

	/**
	 * The state after a change of the `whiteboard_sync` row
	 *
	 * @param array{epoch?:string,digest?:string,etag?:?string,pending_digest?:?string,pending_at?:?int,outside_write?:int,restored?:int} $values
	 */
	public function with(int $rev, array $values): self {
		return new self(
			$this->fileId,
			$values['epoch'] ?? $this->epoch,
			$rev,
			$values['digest'] ?? $this->digest,
			array_key_exists('etag', $values) ? $values['etag'] : $this->etag,
			array_key_exists('pending_digest', $values) ? $values['pending_digest'] : $this->pendingDigest,
			array_key_exists('pending_at', $values) ? $values['pending_at'] : $this->pendingAt,
			array_key_exists('outside_write', $values) ? $values['outside_write'] !== self::OUTSIDE_NONE : $this->outsideWrite,
			array_key_exists('outside_write', $values) ? $values['outside_write'] === self::OUTSIDE_RESTORE : $this->restoreWrite,
			array_key_exists('restored', $values) ? $values['restored'] === 1 : $this->restored,
			$this->outsideCount,
		);
	}
}
