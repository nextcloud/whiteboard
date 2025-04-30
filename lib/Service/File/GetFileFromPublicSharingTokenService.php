<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service\File;

use InvalidArgumentException;
use OCP\Constants;
use OCP\Files\File;
use OCP\Files\NotFoundException;
use OCP\Share\Exceptions\ShareNotFound;
use OCP\Share\IManager as ShareManager;
use OCP\Share\IShare;

/**
 * @psalm-suppress UndefinedDocblockClass
 * @psalm-suppress UndefinedClass
 * @psalm-suppress MissingDependency
 */
final class GetFileFromPublicSharingTokenService implements GetFileService {
	private ?IShare $share = null;

	public function __construct(
		private ShareManager $shareManager,
		private string $publicSharingToken,
		private int $fileId,
	) {
	}

	/**
	 * @throws NotFoundException
	 */
	#[\Override]
	public function getFile(): File {
		try {
			$share = $this->shareManager->getShareByToken($this->publicSharingToken);
		} catch (ShareNotFound) {
			throw new NotFoundException();
		}

		$this->share = $share;

		$node = $share->getNode();

		if ($node instanceof File) {
			return $node;
		}

		$node = $node->getFirstNodeById($this->fileId);

		if ($node instanceof File) {
			return $node;
		}

		throw new InvalidArgumentException('No proper share data');
	}

	#[\Override]
	public function isFileReadOnly(): bool {
		if ($this->share === null) {
			throw new InvalidArgumentException('No share data');
		}

		return !($this->share->getPermissions() & Constants::PERMISSION_UPDATE);
	}
}
