<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Exception;

use OCP\AppFramework\Http;
use RuntimeException;

/**
 * Another request is changing the board; the client sends again later
 */
final class BoardBusyException extends RuntimeException {
	public function __construct() {
		parent::__construct('The board is busy', Http::STATUS_SERVICE_UNAVAILABLE);
	}
}
