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
use OCP\IUserManager;
use OCP\IUserSession;

final class GetSessionUserFromIdService implements GetUserFromIdService {
	public function __construct(
		private IUserManager $userManager,
		private IUserSession $userSession,
		private string       $userId,
	) {
	}

	public function getUser(): User {
		$user = $this->userManager->get($this->userId);
		if (!$user) {
			throw new UnauthorizedException('User not found');
		}
		$this->userSession->setVolatileActiveUser($user);

		return new AuthenticatedUser($user);
	}
}
