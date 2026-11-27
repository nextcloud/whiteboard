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
 * The board was restored or written by someone else since the client loaded
 * it; the client loads it again
 */
final class BoardReplacedException extends RuntimeException {
	public function __construct(
		public readonly BoardState $state,
	) {
		parent::__construct('The board was replaced', Http::STATUS_CONFLICT);
	}
}
