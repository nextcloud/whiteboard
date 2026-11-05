<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Exception;

use OCP\AppFramework\Http;
use RuntimeException;

final class TemplatesFolderUnavailableException extends RuntimeException {
	public function __construct(string $uid) {
		parent::__construct('Templates folder could not be found or created for user: ' . $uid, Http::STATUS_FAILED_DEPENDENCY);
	}
}
