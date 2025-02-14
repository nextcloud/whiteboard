<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Events;

use OCA\Whiteboard\Model\User;
use OCP\EventDispatcher\Event;
use OCP\Files\File;

abstract class AbstractWhiteboardEvent extends Event {
	public function __construct(
		private File $file,
		private User $user,
		private array $data,
	) {
	}

	public function getFile(): File {
		return $this->file;
	}

	public function getUser(): User {
		return $this->user;
	}

	public function getData(): array {
		return $this->data;
	}
}
