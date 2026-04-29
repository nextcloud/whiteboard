<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Exception;

use Exception;

final class WhiteboardConflictException extends Exception {
	/**
	 * @param array<string,mixed> $currentDocument
	 */
	public function __construct(
		private array $currentDocument,
	) {
		parent::__construct('Whiteboard content conflict', 409);
	}

	/**
	 * @return array<string,mixed>
	 */
	public function getCurrentDocument(): array {
		return $this->currentDocument;
	}
}
