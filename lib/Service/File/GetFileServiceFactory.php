<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service\File;

use OCA\Whiteboard\Exception\InvalidUserException;
use OCA\Whiteboard\Model\AuthenticatedUser;
use OCA\Whiteboard\Model\PublicSharingUser;
use OCA\Whiteboard\Model\User;
use OCP\Files\IRootFolder;
use OCP\Share\IManager as ShareManager;

/**
 * @psalm-suppress UndefinedDocblockClass
 * @psalm-suppress UndefinedClass
 * @psalm-suppress MissingDependency
 */
final class GetFileServiceFactory {
	public function __construct(
		private IRootFolder  $rootFolder,
		private ShareManager $shareManager,
	) {
	}

	public function create(User $user, int $fileId): GetFileService {
		if ($user instanceof AuthenticatedUser) {
			return new GetFileFromIdService($this->rootFolder, $user->getUID(), $fileId);
		}

		if ($user instanceof PublicSharingUser) {
			return new GetFileFromPublicSharingTokenService($this->shareManager, $user->getPublicSharingToken(), $fileId);
		}

		throw new InvalidUserException();
	}
}
