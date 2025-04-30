<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service\Authentication;

use Exception;
use OCA\Whiteboard\Exception\InvalidUserException;
use OCA\Whiteboard\Model\User;

final class ChainAuthenticateUserService implements AuthenticateUserService {
	public function __construct(
		private array $strategies,
	) {
	}

	#[\Override]
	public function authenticate(): User {
		foreach ($this->strategies as $strategy) {
			try {
				return $strategy->authenticate();
			} catch (Exception) {
				continue;
			}
		}

		throw new InvalidUserException('No valid authentication method found');
	}
}
