<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service\Authentication;

use OCA\Whiteboard\Exception\UnauthorizedException;
use OCA\Whiteboard\Model\AuthenticatedUser;
use OCA\Whiteboard\Model\User;
use OCP\IUserSession;

final class AuthenticateSessionUserService implements AuthenticateUserService {
	public function __construct(
		private IUserSession $userSession
	) {
	}

	public function authenticate(): User {
		if (!$this->userSession->isLoggedIn()) {
			throw new UnauthorizedException('User not logged in');
		}

		$user = $this->userSession->getUser();
		if ($user === null) {
			throw new UnauthorizedException('User session invalid');
		}

		return new AuthenticatedUser($user);
	}
}
