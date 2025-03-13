<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service\File;

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
	 * @throws InvalidPathException
	 */
	public function getFile(): File {
		$this->logger->warning('Attempting to get file', [
			'user_id' => $this->userId,
			'file_id' => $this->fileId
		]);
		
		$userFolder = $this->rootFolder->getUserFolder($this->userId);
		$this->logger->warning('User folder retrieved', [
			'user_id' => $this->userId,
			'folder_path' => $userFolder->getPath()
		]);

		try {
			$file = $userFolder->getFirstNodeById($this->fileId);
			if ($file instanceof File) {
				$this->logger->warning('File found by getFirstNodeById', [
					'file_path' => $file->getPath(),
					'permissions' => $file->getPermissions(),
					'has_update_permission' => ($file->getPermissions() & Constants::PERMISSION_UPDATE) ? 'yes' : 'no'
				]);
				
				if ($file->getPermissions() & Constants::PERMISSION_UPDATE) {
					$this->file = $file;
					return $file;
				}
			} else {
				$this->logger->warning('Node found is not a file', [
					'node_type' => get_class($file)
				]);
			}
		} catch (NotFoundException $e) {
			$this->logger->warning('File not found by getFirstNodeById: ' . $e->getMessage());
		}

		// Try getting all nodes with this ID
		$this->logger->warning('Trying getById for file ID: ' . $this->fileId);
		$files = $userFolder->getById($this->fileId);
		if (empty($files)) {
			$this->logger->error('File not found by ID: ' . $this->fileId, [
				'user_id' => $this->userId,
				'user_folder_path' => $userFolder->getPath()
			]);
			throw new NotFoundException('File not found');
		}

		$this->logger->warning('Found ' . count($files) . ' files with ID: ' . $this->fileId);

		usort($files, static function (Node $a, Node $b) {
			return ($b->getPermissions() & Constants::PERMISSION_UPDATE) <=> ($a->getPermissions() & Constants::PERMISSION_UPDATE);
		});

		$file = $files[0];
		if (!$file instanceof File) {
			$this->logger->error('Node is not a file', [
				'node_type' => get_class($file),
				'node_path' => $file->getPath(),
				'file_id' => $this->fileId
			]);
			throw new NotFoundException('Not a file');
		}

		if (!($file->getPermissions() & Constants::PERMISSION_READ)) {
			$this->logger->error('No read permission for file', [
				'file_path' => $file->getPath(),
				'permissions' => $file->getPermissions(),
				'file_id' => $this->fileId
			]);
			throw new NotPermittedException('No read permission');
		}

		$this->logger->warning('File successfully retrieved', [
			'file_path' => $file->getPath(),
			'permissions' => $file->getPermissions()
		]);
		
		$this->file = $file;

		return $this->file;
	}

	/**
	 * @throws NotFoundException
	 * @throws InvalidPathException
	 */
	public function isFileReadOnly(): bool {
		if ($this->file === null) {
			$this->logger->error('Cannot check if file is read-only: file not found', [
				'file_id' => $this->fileId
			]);
			throw new NotFoundException('File not found');
		}

		$isReadOnly = !($this->file->getPermissions() & Constants::PERMISSION_UPDATE);
		$this->logger->warning('Checking if file is read-only', [
			'file_path' => $this->file->getPath(),
			'is_read_only' => $isReadOnly,
			'permissions' => $this->file->getPermissions()
		]);
		
		return $isReadOnly;
	}
}
