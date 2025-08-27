<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use JsonException;
use OCA\Whiteboard\AppInfo\Application;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\GenericFileException;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;
use OCP\Files\Template\ITemplateManager;
use OCP\Lock\LockedException;

/**
 * @psalm-suppress UndefinedDocblockClass
 * @psalm-suppress UndefinedClass
 * @psalm-suppress MissingDependency
 */
final class WhiteboardLibraryService {
	public function __construct(
		private ITemplateManager $templateManager,
		private IRootFolder $rootFolder,
	) {
	}

	/**
	 * @throws NotPermittedException
	 * @throws GenericFileException
	 * @throws LockedException
	 * @throws JsonException
	 */
	public function getUserLib(): array {
		// Get the .excalidrawlib files from the /Templates directory
		$availableFileCreators = $this->templateManager->listTemplates();
		$templates = [];
		$libs = [];

		foreach ($availableFileCreators as $fileCreator) {
			if ($fileCreator['app'] !== Application::APP_ID) {
				continue;
			}
			$templates = $fileCreator['templates'];
			break;
		}

		foreach ($templates as $template) {
			$templateDetails = $template->jsonSerialize();

			if (str_ends_with($templateDetails['basename'], '.excalidrawlib')) {
				$fileId = $templateDetails['fileid'];
				$file = $this->rootFolder->getFirstNodeById($fileId);

				if (!$file instanceof File) {
					continue;
				}

				$lib = json_decode($file->getContent(), true, 512, JSON_THROW_ON_ERROR);
				$lib['basename'] = $templateDetails['basename'];
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
		// Check if the user has a Templates folder, if not create one
		if (!$this->templateManager->hasTemplateDirectory()) {
			$this->templateManager->initializeTemplateDirectory(null, $uid, false);
		}

		// Update the .excalidrawlib files in the Templates directory
		$userFolder = $this->rootFolder->getUserFolder($uid);
		$templatesPath = $this->templateManager->getTemplatePath();
		$templatesFolder = $userFolder->get($templatesPath);

		if (!$templatesFolder instanceof Folder) {
			throw new NotFoundException('Templates folder not found for user: ' . $uid);
		}

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
