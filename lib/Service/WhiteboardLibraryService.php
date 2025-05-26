<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use JsonException;
use OCP\Files\File;
use OCP\Files\GenericFileException;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;
use OCP\Lock\LockedException;

final class WhiteboardLibraryService {
	private IRootFolder $rootFolder;

	public function __construct(IRootFolder $rootFolder) {
		$this->rootFolder = $rootFolder;
	}

	/**
	 * @throws NotPermittedException
	 * @throws GenericFileException
	 * @throws LockedException
	 * @throws JsonException
	 */
	public function getUserLib(string $uid): array {
		// Get the .excalidrawlib files from the /Templates directory
		$userFolder = $this->rootFolder->getUserFolder($uid);
		$templatesFolder = $userFolder->get('Templates');
		$libs = [];

		foreach ($templatesFolder->getDirectoryListing() as $file) {
			if (str_ends_with($file->getName(), '.excalidrawlib')) {
				$lib = json_decode($file->getContent(), true, 512, JSON_THROW_ON_ERROR);
				$lib['filename'] = $file->getName();
				$libs[] = $lib;
			}
		}

		return $libs;
	}

	/**
	 * @throws NotPermittedException
	 * @throws NotFoundException
	 * @throws GenericFileException
	 * @throws LockedException
	 * @throws JsonException
	 */
	public function updateUserLib(string $uid, array $items): void {
		// Update the .excalidrawlib files in the /Templates directory
		$userFolder = $this->rootFolder->getUserFolder($uid);
		$templatesFolder = $userFolder->get('Templates');

		$files = [
			'personal.excalidrawlib' => [
				'type' => 'excalidrawlib',
				'version' => 2,
				'libraryItems' => [],
			],
		];

		foreach ($items as $item) {
			if (!isset($item['filename'])) {
				$files['personal.excalidrawlib']['libraryItems'][] = $item;
			} else {
				if (isset($files[$item['filename']])) {
					$files[$item['filename']]['libraryItems'][] = $item;
				} else {
					$files[$item['filename']] = [
						'type' => 'excalidrawlib',
						'version' => 2,
						'libraryItems' => [$item],
					];
				}
			}
		}

		foreach ($files as $filename => $fileData) {
			if ($templatesFolder->nodeExists($filename)) {
				$file = $templatesFolder->get($filename);
			} else {
				$file = $templatesFolder->newFile($filename);
			}

			if (!$file instanceof File) {
				throw new GenericFileException('Failed to create or get file: ' . $filename);
			}

			$file->putContent(json_encode($fileData, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT));
		}
	}
}
