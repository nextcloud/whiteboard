<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service\Authentication;

use Exception;
use OCA\Whiteboard\Exception\UnauthorizedException;
use OCA\Whiteboard\Model\PublicSharingUser;
use OCA\Whiteboard\Model\User;
use OCP\Share\IManager as ShareManager;

final class AuthenticatePublicSharingUserService implements AuthenticateUserService {
	public function __construct(
		private ShareManager $shareManager,
		private ?string $publicSharingToken = null,
	) {
	}

	public function authenticate(): User {
		if (!$this->publicSharingToken) {
			throw new UnauthorizedException('Public sharing token not provided');
		}

		try {
			$this->shareManager->getShareByToken($this->publicSharingToken);
			return new PublicSharingUser($this->publicSharingToken);
		} catch (Exception) {
			throw new UnauthorizedException('Invalid sharing token');
		}
	}
}
