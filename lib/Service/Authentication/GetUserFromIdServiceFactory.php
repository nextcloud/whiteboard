<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service\Authentication;

use OCP\IUserManager;
use OCP\IUserSession;
use OCP\Share\IManager as ShareManager;

final class GetUserFromIdServiceFactory {
	public function __construct(
		private ShareManager $shareManager,
		private IUserManager $userManager,
		private IUserSession $userSession,
	) {
	}

	public function create(string $userId): GetUserFromIdService {
		if (str_starts_with($userId, 'shared_')) {
			return new GetPublicSharingUserFromIdService($this->shareManager, $userId);
		}

		return new GetSessionUserFromIdService($this->userManager, $this->userSession, $userId);
	}
}
