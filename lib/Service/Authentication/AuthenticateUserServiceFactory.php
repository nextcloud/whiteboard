<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service\Authentication;

use OCP\IUserSession;
use OCP\Share\IManager as ShareManager;

final class AuthenticateUserServiceFactory {
	public function __construct(
		private ShareManager $shareManager,
		private IUserSession $userSession
	) {
	}

	public function create(?string $publicSharingToken): AuthenticateUserService {
		$authServices = [
			//Favor the public sharing token over the session,
			//session users sometimes don't have the right permissions
			new AuthenticatePublicSharingUserService($this->shareManager, $publicSharingToken),
			new AuthenticateSessionUserService($this->userSession),
		];

		return new ChainAuthenticateUserService($authServices);
	}
}
