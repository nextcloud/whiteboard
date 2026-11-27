<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Exception;

use OCA\Whiteboard\Model\BoardState;
use OCP\AppFramework\Http;
use RuntimeException;

/**
 * The client last caught up at a revision no delta can start from: the
 * board dropped deletions made after it, or the board is at an older
 * revision, as after a restore from a backup. The client reads the whole
 * board before it saves.
 */
final class BoardBehindException extends RuntimeException {
	public function __construct(
		public readonly BoardState $state,
	) {
		parent::__construct('The client is behind the board', Http::STATUS_CONFLICT);
	}
}
