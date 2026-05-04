<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
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
use OCP\IConfig;
use OCP\Lock\LockedException;
use Psr\Log\LoggerInterface;
use RuntimeException;

/**
 * The Excalidraw palette ("My library"), plus the catalog of saved libraries.
 *
 * - "My library": the single writable palette per user, stored in the user's
 *   Templates folder as personal.excalidrawlib. Returned by getUserLib and the
 *   only thing written by updateUserLib.
 *
 * - Libraries: named shape kits a board can reference. A board stores only a
 *   {scope, name} reference (libraryRef); the live items are resolved on every
 *   open via resolveLibrary, so editing a library propagates to every board
 *   that points at it. Personal libraries live under the user's Templates
 *   folder; organization libraries live in app data and are shared with
 *   everyone. Each library has an items file (<name>.excalidrawlib) and a
 *   pointer board file (<name>.whiteboard holding the libraryRef) that
 *   surfaces it in the "New whiteboard" picker.
 *
 * @psalm-suppress UndefinedDocblockClass
 * @psalm-suppress UndefinedClass
 * @psalm-suppress MissingDependency
 */
final class WhiteboardLibraryService {
	private const PERSONAL_FILE = 'personal.excalidrawlib';
	private const LIBRARY_EXTENSION = '.excalidrawlib';
	private const WHITEBOARD_EXTENSION = '.whiteboard';
	private const PERSONAL_LIBRARY_DIR = '.whiteboard-libraries';
	private const ORG_LIBRARY_DIR = 'libraries';
	private const ORG_LIBRARY_POINTER_DIR = 'library-pointers';
	private const SCOPE_ORG = WhiteboardFolderService::SCOPE_ORG;
	private const LEGACY_MIGRATED_FLAG = 'legacy_libraries_migrated';

	public function __construct(
		private WhiteboardFolderService $folders,
		private IConfig $config,
		private LoggerInterface $logger,
	) {
	}

	/**
	 * The writable personal library ("My library"). Returned as a single source.
	 *
	 * @return array<int, array<string, mixed>>
	 *
	 * @throws NotPermittedException
	 * @throws NotFoundException
	 * @throws GenericFileException
	 */
	public function getUserLib(string $uid): array {
		if (str_starts_with($uid, 'shared_')) {
			return [];
		}

		$folder = $this->folders->getUserTemplateFolder($uid);
		$this->migrateLegacyLibraries($uid, $folder);
		if (!$folder->nodeExists(self::PERSONAL_FILE)) {
			return [];
		}

		$file = $folder->get(self::PERSONAL_FILE);
		if (!$file instanceof File) {
			return [];
		}

		$lib = $this->decodeLibrary($file);
		if ($lib === null) {
			return [];
		}

		$lib['filename'] = self::PERSONAL_FILE;
		$lib['basename'] = self::PERSONAL_FILE;
		$lib['writable'] = true;

		return [$lib];
	}

	/**
	 * Persist the writable personal library. Only personal-origin items reach
	 * here (the editor filters out read-only library items before sending).
	 *
	 * @param array<int, mixed> $items
	 *
	 * @throws NotPermittedException
	 * @throws NotFoundException
	 * @throws GenericFileException
	 * @throws LockedException
	 * @throws JsonException
	 */
	public function updateUserLib(string $uid, array $items): void {
		if (str_starts_with($uid, 'shared_')) {
			return;
		}

		$folder = $this->folders->getUserTemplateFolder($uid);
		$this->writeLibraryFile($folder, self::PERSONAL_FILE, $this->sanitizeLibraryItems($items));
	}

	/**
	 * The library catalog for the picker / save dialog.
	 *
	 * @return array{personal: array<int, array{name: string, itemCount: int}>, org: array<int, array{name: string, itemCount: int}>}
	 *
	 * @throws NotPermittedException
	 * @throws NotFoundException
	 */
	public function listLibraries(string $uid): array {
		// Public-share sessions must not see any libraries, org included.
		if (str_starts_with($uid, 'shared_')) {
			return ['personal' => [], 'org' => []];
		}
		return [
			'personal' => $this->listLibrariesIn($this->getPersonalLibraryFolder($uid)),
			'org' => $this->listLibrariesIn($this->getOrgLibraryFolder(false)),
		];
	}

	/**
	 * Resolve a library reference to its current items (read-only section).
	 * Each item is tagged with `libraryName` = the library name.
	 *
	 * @return array<int, mixed>
	 *
	 * @throws NotPermittedException
	 * @throws NotFoundException
	 */
	public function resolveLibrary(string $uid, string $scope, string $name): array {
		// Public-share sessions must not resolve any libraries, org included.
		if (str_starts_with($uid, 'shared_')) {
			return [];
		}

		$scope = $scope === self::SCOPE_ORG ? self::SCOPE_ORG : WhiteboardFolderService::SCOPE_PERSONAL;
		$name = $this->folders->normalizeName($name);
		$folder = $scope === self::SCOPE_ORG
			? $this->getOrgLibraryFolder(false)
			: $this->getPersonalLibraryFolder($uid);

		if (!$folder instanceof Folder) {
			return [];
		}

		$itemsName = $name . self::LIBRARY_EXTENSION;
		if (!$folder->nodeExists($itemsName)) {
			return [];
		}
		$file = $folder->get($itemsName);
		if (!$file instanceof File) {
			return [];
		}

		$lib = $this->decodeLibrary($file);
		$items = is_array($lib) && isset($lib['libraryItems']) && is_array($lib['libraryItems']) ? $lib['libraryItems'] : [];

		$tagged = [];
		foreach ($this->sanitizeLibraryItems($items) as $item) {
			$item['libraryName'] = $name;
			// Namespace the id: saved kits keep their source item ids, so a kit
			// created from "My library" would otherwise collide with the
			// originals in the editor's palette (one id, two sections).
			$sourceId = isset($item['id']) && is_string($item['id']) && $item['id'] !== ''
				? $item['id']
				: bin2hex(random_bytes(6));
			$item['id'] = $scope . ':' . $name . ':' . $sourceId;
			$tagged[] = $item;
		}
		return $tagged;
	}

	/**
	 * Create or replace a saved library from library items.
	 *
	 * @param array<int, mixed> $items
	 *
	 * @return array{name: string, scope: string}
	 *
	 * @throws NotPermittedException
	 * @throws NotFoundException
	 * @throws GenericFileException
	 */
	public function saveLibrary(string $uid, string $scope, string $name, array $items): array {
		$scope = $this->folders->normalizeScope($scope);
		$this->folders->assertScopeWritable($scope);
		$name = $this->folders->normalizeName($name);
		$this->folders->enforceFilenamePolicy($name, self::LIBRARY_EXTENSION, self::WHITEBOARD_EXTENSION);
		$sanitized = $this->sanitizeLibraryItems($items);
		if (count($sanitized) === 0) {
			throw new InvalidArgumentException('Select at least one shape to save as a library', Http::STATUS_BAD_REQUEST);
		}
		if ($this->containsImageElement($sanitized)) {
			throw new InvalidArgumentException('This library contains image items that cannot be imported by Whiteboard yet.', Http::STATUS_BAD_REQUEST);
		}

		// Resolve and check the pointer slot before writing the items file, so
		// a name conflict cannot leave an orphaned items file behind.
		$pointerFolder = $scope === self::SCOPE_ORG
			? $this->getOrgLibraryPointerFolder(true)
			: $this->folders->getUserTemplateFolder($uid);
		if (!$pointerFolder instanceof Folder) {
			throw new NotFoundException('Library pointer folder not available');
		}
		$pointerName = $name . self::WHITEBOARD_EXTENSION;
		if ($pointerFolder->nodeExists($pointerName)) {
			$existing = $pointerFolder->get($pointerName);
			if ($existing instanceof File && !$this->folders->isLibraryPointer($existing)) {
				throw new InvalidArgumentException('A canvas template named "' . $name . '" already exists. Choose a different name.', Http::STATUS_CONFLICT);
			}
		}

		$folder = $scope === self::SCOPE_ORG
			? $this->getOrgLibraryFolder(true)
			: $this->getPersonalLibraryFolder($uid, true);
		if (!$folder instanceof Folder) {
			throw new NotFoundException('Library folder not available');
		}

		$this->writeLibraryFile($folder, $name . self::LIBRARY_EXTENSION, $sanitized);
		$this->writeLibraryPointer($pointerFolder, $scope, $name);

		return ['name' => $name, 'scope' => $scope];
	}

	/**
	 * @throws NotPermittedException
	 * @throws NotFoundException
	 */
	public function deleteLibrary(string $uid, string $scope, string $name): void {
		$scope = $this->folders->normalizeScope($scope);
		$name = $this->folders->normalizeName($name);

		$folder = $scope === self::SCOPE_ORG
			? $this->getOrgLibraryFolder(false)
			: $this->getPersonalLibraryFolder($uid);
		$this->folders->deleteIfExists($folder, $name . self::LIBRARY_EXTENSION);

		$pointerFolder = $scope === self::SCOPE_ORG
			? $this->getOrgLibraryPointerFolder(false)
			: ($this->folders->hasTemplateDirectory() ? $this->folders->getUserTemplateFolder($uid) : null);
		$pointerName = $name . self::WHITEBOARD_EXTENSION;
		if ($pointerFolder instanceof Folder && $pointerFolder->nodeExists($pointerName)) {
			$node = $pointerFolder->get($pointerName);
			// A personal canvas template shares the pointer's path
			// (Templates/<name>.whiteboard) — only delete actual pointers.
			if ($node instanceof File && $this->folders->isLibraryPointer($node)) {
				$node->delete();
			}
		}
	}

	/**
	 * Pointer board files for the organization picker entries.
	 *
	 * @return array<int, File>
	 */
	public function getOrgLibraryPointerFiles(): array {
		$folder = $this->getOrgLibraryPointerFolder(false);
		if (!$folder instanceof Folder) {
			return [];
		}
		$files = [];
		foreach ($folder->getDirectoryListing() as $node) {
			if ($node instanceof File && $this->isWhiteboardFile($node->getName())) {
				$files[] = $node;
			}
		}
		return $files;
	}

	public function libraryNameFromPointer(string $fileName): string {
		return $this->isWhiteboardFile($fileName)
			? substr($fileName, 0, -strlen(self::WHITEBOARD_EXTENSION))
			: $fileName;
	}

	/**
	 * Parse an uploaded .excalidrawlib file (v1 or v2) into library items.
	 *
	 * @return array<int, mixed>
	 */
	public function parseLibraryFile(string $content): array {
		try {
			$data = json_decode($content, true, 512, JSON_THROW_ON_ERROR);
		} catch (JsonException) {
			throw new InvalidArgumentException('This is not a valid library file.', Http::STATUS_BAD_REQUEST);
		}
		if (!is_array($data)) {
			throw new InvalidArgumentException('This is not a valid library file.', Http::STATUS_BAD_REQUEST);
		}

		$items = [];
		if (isset($data['libraryItems']) && is_array($data['libraryItems'])) {
			$items = $data['libraryItems'];
		} elseif (isset($data['library']) && is_array($data['library'])) {
			foreach ($data['library'] as $elements) {
				if (is_array($elements)) {
					$items[] = ['elements' => $elements];
				}
			}
		}

		$sanitized = $this->sanitizeLibraryItems($items);
		if (count($sanitized) === 0) {
			throw new InvalidArgumentException('This library file has no items.', Http::STATUS_BAD_REQUEST);
		}
		if ($this->containsImageElement($sanitized)) {
			throw new InvalidArgumentException('This library contains image items that cannot be imported by Whiteboard yet.', Http::STATUS_BAD_REQUEST);
		}
		return $sanitized;
	}

	// ---------------------------------------------------------------------
	// internals
	// ---------------------------------------------------------------------

	/**
	 * One-time merge of pre-1.6 library files into "My library". Older
	 * releases read every *.excalidrawlib in the Templates folder (the manual
	 * import flow for excalidraw.com kits); the new model only reads
	 * personal.excalidrawlib, so without this their items would silently
	 * disappear from the palette. The legacy files are left in place — only
	 * the migrated flag stops them from being merged again.
	 */
	private function migrateLegacyLibraries(string $uid, Folder $templatesFolder): void {
		if ($this->config->getUserValue($uid, 'whiteboard', self::LEGACY_MIGRATED_FLAG, '') === '1') {
			return;
		}

		$legacyItems = [];
		foreach ($templatesFolder->getDirectoryListing() as $node) {
			if (!$node instanceof File
				|| !$this->isLibraryFile($node->getName())
				|| $node->getName() === self::PERSONAL_FILE) {
				continue;
			}
			$lib = $this->decodeLibrary($node);
			if ($lib === null) {
				continue;
			}
			$items = [];
			if (isset($lib['libraryItems']) && is_array($lib['libraryItems'])) {
				$items = $lib['libraryItems'];
			} elseif (isset($lib['library']) && is_array($lib['library'])) {
				// v1 files are bare element lists without item metadata.
				foreach ($lib['library'] as $elements) {
					if (is_array($elements)) {
						$items[] = ['elements' => $elements];
					}
				}
			}
			$legacyItems = array_merge($legacyItems, $this->sanitizeLibraryItems($items));
		}

		if ($legacyItems !== []) {
			$existing = [];
			if ($templatesFolder->nodeExists(self::PERSONAL_FILE)) {
				$file = $templatesFolder->get(self::PERSONAL_FILE);
				if ($file instanceof File) {
					$lib = $this->decodeLibrary($file);
					if (is_array($lib) && isset($lib['libraryItems']) && is_array($lib['libraryItems'])) {
						$existing = $this->sanitizeLibraryItems($lib['libraryItems']);
					}
				}
			}
			$existingIds = [];
			foreach ($existing as $item) {
				if (isset($item['id']) && is_string($item['id'])) {
					$existingIds[$item['id']] = true;
				}
			}
			foreach ($legacyItems as $item) {
				if (isset($item['id']) && is_string($item['id']) && isset($existingIds[$item['id']])) {
					continue;
				}
				$existing[] = $item;
			}
			$this->writeLibraryFile($templatesFolder, self::PERSONAL_FILE, $existing);
			$this->logger->info('Merged legacy whiteboard library files into personal library', [
				'app' => 'whiteboard',
				'itemCount' => count($legacyItems),
			]);
		}

		$this->config->setUserValue($uid, 'whiteboard', self::LEGACY_MIGRATED_FLAG, '1');
	}

	private function decodeLibrary(File $file): ?array {
		try {
			$lib = json_decode($file->getContent(), true, 512, JSON_THROW_ON_ERROR);
		} catch (JsonException) {
			$this->logger->warning('Skipping malformed whiteboard library', [
				'app' => 'whiteboard',
				'file' => $file->getName(),
			]);
			return null;
		}
		return is_array($lib) ? $lib : null;
	}

	/**
	 * @param array<int, mixed> $items
	 *
	 * @throws NotPermittedException
	 * @throws GenericFileException
	 */
	private function writeLibraryFile(Folder $folder, string $fileName, array $items): void {
		$payload = ['type' => 'excalidrawlib', 'version' => 2, 'libraryItems' => array_values($items)];
		$file = $folder->nodeExists($fileName) ? $folder->get($fileName) : $folder->newFile($fileName);
		if (!$file instanceof File) {
			throw new GenericFileException('Failed to create or get file: ' . $fileName);
		}
		$file->putContent(json_encode($payload, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT));
	}

	/**
	 * Write the pointer ".whiteboard" file that surfaces a library in the picker.
	 *
	 * @throws NotPermittedException
	 * @throws GenericFileException
	 */
	private function writeLibraryPointer(Folder $folder, string $scope, string $name): void {
		$content = json_encode([
			'elements' => [],
			'files' => [],
			'scrollToContent' => true,
			'libraryRef' => ['scope' => $scope, 'name' => $name],
		], JSON_THROW_ON_ERROR);

		$fileName = $name . self::WHITEBOARD_EXTENSION;
		$file = $folder->nodeExists($fileName) ? $folder->get($fileName) : $folder->newFile($fileName);
		if (!$file instanceof File) {
			throw new GenericFileException('Failed to create or get pointer: ' . $fileName);
		}
		$file->putContent($content);
	}

	/**
	 * @return array<int, array{name: string, itemCount: int}>
	 */
	private function listLibrariesIn(?Folder $folder): array {
		if (!$folder instanceof Folder) {
			return [];
		}
		$libraries = [];
		foreach ($folder->getDirectoryListing() as $node) {
			if (!$node instanceof File || !$this->isLibraryFile($node->getName())) {
				continue;
			}
			$lib = $this->decodeLibrary($node);
			$itemCount = is_array($lib) && isset($lib['libraryItems']) && is_array($lib['libraryItems']) ? count($lib['libraryItems']) : 0;
			$libraries[] = [
				'name' => substr($node->getName(), 0, -strlen(self::LIBRARY_EXTENSION)),
				'itemCount' => $itemCount,
			];
		}
		usort($libraries, static fn (array $a, array $b): int => strcasecmp($a['name'], $b['name']));
		return $libraries;
	}

	/**
	 * Returns null when the folder does not exist yet and $create is false,
	 * so list/resolve/delete on a fresh account yield empty results, not 404s.
	 *
	 * @throws NotPermittedException
	 * @throws NotFoundException
	 */
	private function getPersonalLibraryFolder(string $uid, bool $create = false): ?Folder {
		$templates = $this->folders->getUserTemplateFolder($uid);
		if (!$templates->nodeExists(self::PERSONAL_LIBRARY_DIR)) {
			if (!$create) {
				return null;
			}
			$templates->newFolder(self::PERSONAL_LIBRARY_DIR);
		}
		$node = $templates->get(self::PERSONAL_LIBRARY_DIR);
		if (!$node instanceof Folder) {
			throw new RuntimeException('Expected folder ' . self::PERSONAL_LIBRARY_DIR);
		}
		return $node;
	}

	private function getOrgLibraryFolder(bool $create): ?Folder {
		return $this->folders->getAppDataFolder(self::ORG_LIBRARY_DIR, $create);
	}

	private function getOrgLibraryPointerFolder(bool $create): ?Folder {
		return $this->folders->getAppDataFolder(self::ORG_LIBRARY_POINTER_DIR, $create);
	}

	/**
	 * @param array<int, mixed> $items
	 *
	 * @return array<int, mixed>
	 */
	private function sanitizeLibraryItems(array $items): array {
		$sanitized = [];
		foreach ($items as $item) {
			if (!is_array($item) || !isset($item['elements']) || !is_array($item['elements']) || count($item['elements']) === 0) {
				continue;
			}
			unset($item['filename'], $item['basename'], $item['name'], $item['writable'], $item['libraryName']);
			$item['elements'] = array_values($item['elements']);
			$sanitized[] = $item;
		}
		return $sanitized;
	}

	/**
	 * Library files carry no binary file data, so image elements would render
	 * as permanently broken placeholders once resolved into a board.
	 *
	 * @param array<int, mixed> $items
	 */
	private function containsImageElement(array $items): bool {
		foreach ($items as $item) {
			if (!is_array($item) || !isset($item['elements']) || !is_array($item['elements'])) {
				continue;
			}
			foreach ($item['elements'] as $element) {
				if (is_array($element) && ($element['type'] ?? null) === 'image') {
					return true;
				}
			}
		}
		return false;
	}

	private function isLibraryFile(string $fileName): bool {
		return str_ends_with(strtolower($fileName), self::LIBRARY_EXTENSION);
	}

	private function isWhiteboardFile(string $fileName): bool {
		return str_ends_with(strtolower($fileName), self::WHITEBOARD_EXTENSION);
	}
}
