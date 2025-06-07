<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service\File;

use OC\User\NoUserException;
use OCP\Constants;
use OCP\Files\File;
use OCP\Files\InvalidPathException;
use OCP\Files\IRootFolder;
use OCP\Files\Node;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;
use Psr\Log\LoggerInterface;

/**
 * @psalm-suppress UndefinedDocblockClass
 * @psalm-suppress UndefinedClass
 * @psalm-suppress MissingDependency
 */
final class GetFileFromIdService implements GetFileService {
	private ?File $file = null;

	public function __construct(
		private IRootFolder $rootFolder,
		private string $userId,
		private int $fileId,
		private LoggerInterface $logger,
	) {
	}

	/**
	 * @throws NotFoundException
	 * @throws NotPermittedException
	 * @throws NoUserException
	 * @throws InvalidPathException
	 */
	#[\Override]
	public function getFile(): File {
		$userFolder = $this->rootFolder->getUserFolder($this->userId);

		$file = $userFolder->getFirstNodeById($this->fileId);
		if ($file instanceof File && $file->getPermissions() & Constants::PERMISSION_UPDATE) {
			$this->file = $file;
			return $file;
		}

		$files = $userFolder->getById($this->fileId);
		if (empty($files)) {
			$this->logger->error('File not found', [
				'user_id' => $this->userId,
				'file_id' => $this->fileId
			]);
			throw new NotFoundException('File not found');
		}

		usort($files, static function (Node $a, Node $b) {
			return ($b->getPermissions() & Constants::PERMISSION_UPDATE) <=> ($a->getPermissions() & Constants::PERMISSION_UPDATE);
		});

		$file = $files[0];
		if (!$file instanceof File) {
			$this->logger->error('Node is not a file', [
				'file_id' => $this->fileId,
				'node_type' => get_class($file)
			]);
			throw new NotFoundException('Not a file');
		}

		if (!($file->getPermissions() & Constants::PERMISSION_READ)) {
			$this->logger->error('No read permission for file', [
				'file_id' => $this->fileId,
				'permissions' => $file->getPermissions()
			]);
			throw new NotPermittedException('No read permission');
		}

		$this->file = $file;
		return $this->file;
	}

	/**
	 * @throws NotFoundException
	 * @throws InvalidPathException
	 */
	#[\Override]
	public function isFileReadOnly(): bool {
		if ($this->file === null) {
			throw new NotFoundException('File not found');
		}

		return !($this->file->getPermissions() & Constants::PERMISSION_UPDATE);
	}
}
