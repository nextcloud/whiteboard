<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Model;

/**
 * The save state of a board. `digest` is the SHA-256 of the bytes Whiteboard
 * last wrote; `pendingDigest` (and `pendingEpoch` for a restore) are set while
 * a write is on its way.
 */
final class BoardState {
	public function __construct(
		public readonly int $fileId,
		public readonly string $epoch,
		public readonly int $rev,
		public readonly string $digest,
		public readonly ?string $etag,
		public readonly ?string $pendingDigest,
		public readonly ?string $pendingEpoch,
		public readonly ?int $pendingAt,
		public readonly bool $outsideWrite,
	) {
	}

	/**
	 * The state after a change of the `whiteboard_sync` row
	 *
	 * @param array{epoch?:string,digest?:string,etag?:?string,pending_digest?:?string,pending_epoch?:?string,pending_at?:?int,outside_write?:int} $values
	 */
	public function with(int $rev, array $values): self {
		return new self(
			$this->fileId,
			$values['epoch'] ?? $this->epoch,
			$rev,
			$values['digest'] ?? $this->digest,
			array_key_exists('etag', $values) ? $values['etag'] : $this->etag,
			array_key_exists('pending_digest', $values) ? $values['pending_digest'] : $this->pendingDigest,
			array_key_exists('pending_epoch', $values) ? $values['pending_epoch'] : $this->pendingEpoch,
			array_key_exists('pending_at', $values) ? $values['pending_at'] : $this->pendingAt,
			array_key_exists('outside_write', $values) ? $values['outside_write'] === 1 : $this->outsideWrite,
		);
	}
}
