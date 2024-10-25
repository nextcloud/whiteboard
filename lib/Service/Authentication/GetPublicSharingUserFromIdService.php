<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service\Authentication;

use Exception;
use OCA\Whiteboard\Exception\InvalidUserException;
use OCA\Whiteboard\Exception\UnauthorizedException;
use OCA\Whiteboard\Model\PublicSharingUser;
use OCA\Whiteboard\Model\User;
use OCP\Share\IManager as ShareManager;

final class GetPublicSharingUserFromIdService implements GetUserFromIdService {
	public function __construct(
		private ShareManager $shareManager,
		private string $userId,
	) {
	}

	public function getUser(): User {
		$parts = explode('_', $this->userId);
		if (count($parts) < 3) {
			throw new InvalidUserException('Invalid public sharing user ID format');
		}
		$publicSharingToken = $parts[1];

		try {
			$this->shareManager->getShareByToken($publicSharingToken);
			return new PublicSharingUser($publicSharingToken);
		} catch (Exception) {
			throw new UnauthorizedException('Invalid sharing token');
		}
	}
}
