<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Exception;

use OCP\AppFramework\Http;
use RuntimeException;

final class InvalidUserException extends RuntimeException {
	public function __construct(string $message = 'Invalid user') {
		parent::__construct($message, Http::STATUS_BAD_REQUEST);
	}
}
