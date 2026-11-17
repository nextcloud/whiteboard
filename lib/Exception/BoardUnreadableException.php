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
 * The stored bytes are not a board, for example after a write was cut off;
 * only a repair from a client's whole scene may overwrite them
 */
final class BoardUnreadableException extends RuntimeException {
	public function __construct(
		public readonly BoardState $state,
	) {
		parent::__construct('The board cannot be read', Http::STATUS_CONFLICT);
	}
}
