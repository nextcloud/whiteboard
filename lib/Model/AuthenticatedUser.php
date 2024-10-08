<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Model;

use OCP\IUser;

final class AuthenticatedUser implements User {
	public function __construct(
		private IUser $user,
	) {
	}

	public function getUID(): string {
		return $this->user->getUID();
	}

	public function getDisplayName(): string {
		return $this->user->getDisplayName();
	}
}
