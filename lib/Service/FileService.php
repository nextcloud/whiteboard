<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use OC\User\NoUserException;
use OCP\Constants;
use OCP\Files\File;
use OCP\Files\InvalidPathException;
use OCP\Files\IRootFolder;
use OCP\Files\Node;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;

/**
 * @psalm-suppress UndefinedDocblockClass
 * @psalm-suppress UndefinedClass
 * @psalm-suppress MissingDependency
 */
final class FileService {
	public function __construct(
		private IRootFolder $rootFolder
	) {
	}

	/**
	 * @throws NotFoundException
	 * @throws NotPermittedException
	 * @throws NoUserException
	 * @throws InvalidPathException
	 */
	public function getUserFileById(string $userId, int $fileId): File {
		$userFolder = $this->rootFolder->getUserFolder($userId);

		$file = $userFolder->getFirstNodeById($fileId);
		if ($file instanceof File && $file->getPermissions() & Constants::PERMISSION_UPDATE) {
			return $file;
		}

		$files = $userFolder->getById($fileId);
		if (empty($files)) {
			throw new NotFoundException('File not found');
		}

		usort($files, static function (Node $a, Node $b) {
			return ($b->getPermissions() & Constants::PERMISSION_UPDATE) <=> ($a->getPermissions() & Constants::PERMISSION_UPDATE);
		});

		$file = $files[0];
		if (!$file instanceof File) {
			throw new NotFoundException('Not a file');
		}

		if (!($file->getPermissions() & Constants::PERMISSION_READ)) {
			throw new NotPermittedException('No read permission');
		}

		return $file;
	}
}
