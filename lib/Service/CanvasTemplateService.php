<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use InvalidArgumentException;
use JsonException;
use OCP\AppFramework\Http;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\GenericFileException;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;
use Psr\Log\LoggerInterface;

/**
 * Full-board canvas templates: real ".whiteboard" files whose content is
 * copied verbatim by Nextcloud's template machinery when a board is created
 * from them. Personal canvas templates live in the user's Templates folder;
 * organization canvas templates live in app data and are published by admins.
 *
 * @psalm-suppress UndefinedDocblockClass
 * @psalm-suppress UndefinedClass
 * @psalm-suppress MissingDependency
 */
final class CanvasTemplateService {
	public const MAX_CANVAS_TEMPLATE_BYTES = 15 * 1024 * 1024;

	private const ORG_CANVAS_TEMPLATE_DIR = 'templates';
	private const WHITEBOARD_EXTENSION = '.whiteboard';
	private const SCOPE_ORG = WhiteboardFolderService::SCOPE_ORG;

	/**
	 * @psalm-suppress PossiblyUnusedMethod
	 */
	public function __construct(
		private WhiteboardFolderService $folders,
		private LoggerInterface $logger,
	) {
	}

	/**
	 * Validate and canonicalize a board payload into canvas template content.
	 *
	 * @param string|array<string, mixed> $raw
	 *
	 * @return array{elements: array<int, mixed>, files: array<string, mixed>, appState?: array<string, mixed>, scrollToContent: true}
	 */
	public function parseCanvasTemplateData(string|array $raw): array {
		if (is_string($raw)) {
			if (strlen($raw) > self::MAX_CANVAS_TEMPLATE_BYTES) {
				throw new InvalidArgumentException('Canvas is too large (max 15 MB).', Http::STATUS_BAD_REQUEST);
			}
			try {
				$raw = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
			} catch (JsonException) {
				throw new InvalidArgumentException('This is not a valid whiteboard file.', Http::STATUS_BAD_REQUEST);
			}
		}
		if (!is_array($raw)) {
			throw new InvalidArgumentException('This is not a valid whiteboard file.', Http::STATUS_BAD_REQUEST);
		}

		$elements = [];
		foreach (is_array($raw['elements'] ?? null) ? $raw['elements'] : [] as $element) {
			if (is_array($element)) {
				$elements[] = $element;
			}
		}
		if (count($elements) === 0) {
			throw new InvalidArgumentException('This whiteboard has no content to save as a canvas.', Http::STATUS_BAD_REQUEST);
		}

		$files = [];
		foreach (is_array($raw['files'] ?? null) ? $raw['files'] : [] as $key => $file) {
			if (is_array($file)) {
				$files[(string)$key] = $file;
			}
		}

		$data = [
			'elements' => $elements,
			'files' => $files,
			'scrollToContent' => true,
		];

		if (isset($raw['appState']) && is_array($raw['appState'])) {
			$appState = $raw['appState'];
			unset($appState['collaborators'], $appState['selectedElementIds']);
			if (!empty($appState)) {
				$data['appState'] = $appState;
			}
		}

		try {
			$encoded = json_encode($data, JSON_THROW_ON_ERROR);
		} catch (JsonException) {
			throw new InvalidArgumentException('This is not a valid whiteboard file.', Http::STATUS_BAD_REQUEST);
		}
		if (strlen($encoded) > self::MAX_CANVAS_TEMPLATE_BYTES) {
			throw new InvalidArgumentException('Canvas is too large (max 15 MB).', Http::STATUS_BAD_REQUEST);
		}

		return $data;
	}

	/**
	 * Write a canvas template file from canonical board data (see parseCanvasTemplateData).
	 *
	 * @param array<string, mixed> $data
	 *
	 * @return array{name: string, scope: string}
	 *
	 * @throws NotPermittedException
	 * @throws NotFoundException
	 * @throws GenericFileException
	 */
	public function publishCanvasTemplate(string $uid, string $scope, string $name, array $data): array {
		$scope = $this->folders->normalizeScope($scope);
		$this->folders->assertScopeWritable($scope);
		$name = $this->folders->normalizeName($name);
		$this->folders->enforceFilenamePolicy($name, self::WHITEBOARD_EXTENSION);

		$folder = $scope === self::SCOPE_ORG
			? $this->getOrgCanvasTemplateFolder(true)
			: $this->folders->getUserTemplateFolder($uid);
		if (!$folder instanceof Folder) {
			throw new NotFoundException('Canvas template folder not available');
		}

		$fileName = $name . self::WHITEBOARD_EXTENSION;
		$file = $folder->nodeExists($fileName) ? $folder->get($fileName) : $folder->newFile($fileName);
		if (!$file instanceof File) {
			throw new GenericFileException('Failed to create or get canvas template: ' . $fileName);
		}
		// Personal canvas templates share the Templates folder with library
		// pointer boards — never overwrite a library's pointer.
		if ($this->folders->isLibraryPointer($file)) {
			throw new InvalidArgumentException('A library named "' . $name . '" already exists. Choose a different name.', Http::STATUS_CONFLICT);
		}
		$file->putContent(json_encode($data, JSON_THROW_ON_ERROR));

		return ['name' => $name, 'scope' => $scope];
	}

	/**
	 * @return array<int, array{name: string, elementCount: int, sizeBytes: int}>
	 */
	public function listOrgCanvasTemplates(): array {
		$templates = [];
		foreach ($this->getOrgCanvasTemplateFiles() as $file) {
			$elementCount = 0;
			try {
				$content = json_decode($file->getContent(), true, 512, JSON_THROW_ON_ERROR);
				if (is_array($content) && isset($content['elements']) && is_array($content['elements'])) {
					$elementCount = count($content['elements']);
				}
			} catch (JsonException) {
				$this->logger->warning('Skipping malformed whiteboard canvas template', [
					'app' => 'whiteboard',
					'file' => $file->getName(),
				]);
			}
			$templates[] = [
				'name' => $this->canvasTemplateNameFromFile($file->getName()),
				'elementCount' => $elementCount,
				'sizeBytes' => (int)$file->getSize(),
			];
		}
		usort($templates, static fn (array $a, array $b): int => strcasecmp($a['name'], $b['name']));
		return $templates;
	}

	/**
	 * @throws NotPermittedException
	 * @throws NotFoundException
	 */
	public function deleteOrgCanvasTemplate(string $name): void {
		$name = $this->folders->normalizeName($name);
		$this->folders->deleteIfExists($this->getOrgCanvasTemplateFolder(false), $name . self::WHITEBOARD_EXTENSION);
	}

	/**
	 * Organization canvas template files for the picker.
	 *
	 * @return array<int, File>
	 */
	public function getOrgCanvasTemplateFiles(): array {
		$folder = $this->getOrgCanvasTemplateFolder(false);
		if (!$folder instanceof Folder) {
			return [];
		}
		$files = [];
		foreach ($folder->getDirectoryListing() as $node) {
			if ($node instanceof File && str_ends_with(strtolower($node->getName()), self::WHITEBOARD_EXTENSION)) {
				$files[] = $node;
			}
		}
		return $files;
	}

	public function canvasTemplateNameFromFile(string $fileName): string {
		return str_ends_with(strtolower($fileName), self::WHITEBOARD_EXTENSION)
			? substr($fileName, 0, -strlen(self::WHITEBOARD_EXTENSION))
			: $fileName;
	}

	private function getOrgCanvasTemplateFolder(bool $create): ?Folder {
		return $this->folders->getAppDataFolder(self::ORG_CANVAS_TEMPLATE_DIR, $create);
	}
}
