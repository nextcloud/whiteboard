<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use Exception;
use InvalidArgumentException;
use JsonException;
use OCP\AppFramework\Http;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\GenericFileException;
use OCP\Files\IFilenameValidator;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;
use OCP\Files\Template\ITemplateManager;
use OCP\IConfig;
use OCP\Lock\LockedException;
use Psr\Log\LoggerInterface;
use RuntimeException;

/**
 * @psalm-suppress UndefinedDocblockClass
 * @psalm-suppress UndefinedClass
 * @psalm-suppress MissingDependency
 */
final class WhiteboardLibraryService {
	private const LIB_EXTENSION = '.excalidrawlib';
	private const PERSONAL_TEMPLATE = 'personal';
	private const BOARD_TEMPLATE = 'board';
	private const DEFAULT_TEMPLATE_DIR = 'Templates/';
	private const GLOBAL_TEMPLATE_DIR = 'global-libraries';
	private const GLOBAL_SCOPE = 'global';
	private const USER_SCOPE = 'user';
	private const MAX_FILENAME_BYTES = 250;
	private const VOLATILE_ELEMENT_KEYS = [
		'id' => true,
		'seed' => true,
		'version' => true,
		'versionNonce' => true,
		'updated' => true,
		'index' => true,
		'groupIds' => true,
		'frameId' => true,
		'boundElements' => true,
		'containerId' => true,
	];

	public function __construct(
		private ITemplateManager $templateManager,
		private IRootFolder $rootFolder,
		private IFilenameValidator $filenameValidator,
		private IConfig $config,
		private LoggerInterface $logger,
	) {
	}

	/**
	 * @throws NotPermittedException
	 * @throws GenericFileException
	 * @throws LockedException
	 */
	public function getTemplates(string $uid): array {
		return [
			'templates' => $this->listUserTemplates($uid)['templates'],
		];
	}

	/**
	 * @throws NotPermittedException
	 * @throws GenericFileException
	 * @throws LockedException
	 */
	public function getGlobalTemplateMetadata(): array {
		return [
			'templates' => array_map(static fn (array $template): array => [
				'templateName' => $template['templateName'],
				'scope' => $template['scope'],
				'itemCount' => count($template['items']),
			], $this->listGlobalTemplates()['templates']),
		];
	}

	/**
	 * @return array<string, File>
	 *
	 * @throws NotPermittedException
	 * @throws GenericFileException
	 * @throws LockedException
	 */
	public function getGlobalTemplateFiles(): array {
		return $this->listGlobalTemplates()['files'];
	}

	/**
	 * @throws NotPermittedException
	 * @throws GenericFileException
	 * @throws LockedException
	 * @throws NotFoundException
	 */
	public function getGlobalTemplateFile(string $templateName): File {
		$normalizedName = $this->normalizeTemplateName($templateName);
		$files = $this->getGlobalTemplateFiles();
		$file = $files[$this->toCaseKey($normalizedName)] ?? null;
		if (!$file instanceof File) {
			throw new NotFoundException('Organization library template not found');
		}
		return $file;
	}

	/**
	 * @throws NotPermittedException
	 * @throws GenericFileException
	 * @throws LockedException
	 * @throws JsonException
	 */
	public function saveGlobalTemplateFromUpload(string $fileName, string $content): array {
		if (!$this->isLibraryFileName($fileName)) {
			throw new InvalidArgumentException('Upload an .excalidrawlib file', Http::STATUS_BAD_REQUEST);
		}

		$templateName = $this->normalizeTemplateName($fileName);
		$this->assertGlobalTemplateNameAllowed($templateName);
		$caseKey = $this->toCaseKey($templateName);
		$current = $this->listGlobalTemplates();

		if (isset($current['loadedFiles'][$caseKey])) {
			throw new RuntimeException('A library template with this name already exists. Rename the file and upload it again.', Http::STATUS_CONFLICT);
		}

		$items = $this->parseLibraryContent($content);
		if ($items === null) {
			throw new InvalidArgumentException('This is not a valid Excalidraw library file.', Http::STATUS_BAD_REQUEST);
		}
		if ($items === []) {
			throw new InvalidArgumentException('This library has no reusable items. Upload a library with at least one item.', Http::STATUS_BAD_REQUEST);
		}

		$this->writeLibraryTemplate($this->getGlobalTemplateFolder(), $templateName, $items);

		return [
			'templateName' => $templateName,
			'scope' => self::GLOBAL_SCOPE,
			'itemCount' => count($items),
		];
	}

	/**
	 * @throws NotPermittedException
	 * @throws GenericFileException
	 * @throws LockedException
	 * @throws NotFoundException
	 */
	public function deleteGlobalTemplate(string $templateName): void {
		$normalizedName = $this->normalizeTemplateName($templateName);
		$current = $this->listGlobalTemplates();
		$fileName = $current['loadedFiles'][$this->toCaseKey($normalizedName)] ?? null;
		if (!is_string($fileName)) {
			throw new NotFoundException('Organization library template not found');
		}

		$node = $this->getGlobalTemplateFolder()->get($fileName);
		if (!$node instanceof File) {
			throw new NotFoundException('Organization library template not found');
		}
		$node->delete();
	}

	/**
	 * @throws NotPermittedException
	 * @throws NotFoundException
	 * @throws GenericFileException
	 * @throws LockedException
	 * @throws JsonException
	 */
	public function updateUserTemplates(string $uid, array $templates): void {
		$templateFolder = $this->getUserTemplateFolder($uid);
		$current = $this->listUserTemplates($uid);
		$loadedFiles = $current['loadedFiles'];
		$payload = $this->normalizePayloadTemplates($templates, $loadedFiles);

		foreach ($payload as $templateName => $items) {
			$this->writeUserTemplate($templateFolder, $templateName, $items);
		}
	}

	/**
	 * @throws NotPermittedException
	 * @throws NotFoundException
	 * @throws GenericFileException
	 * @throws LockedException
	 * @throws JsonException
	 */
	public function saveUserTemplate(string $uid, string $templateName, array $items): array {
		$templateFolder = $this->getUserTemplateFolder($uid);
		$normalizedName = $this->normalizeTemplateName($templateName);
		$caseKey = $this->toCaseKey($normalizedName);
		$current = $this->listUserTemplates($uid);
		$userNames = $current['loadedFiles'];
		$normalizedItems = $this->normalizeLibraryItems($items);

		if (isset($userNames[$caseKey])) {
			throw new RuntimeException('Library template already exists', Http::STATUS_CONFLICT);
		}

		if ($normalizedItems === []) {
			throw new InvalidArgumentException('Library template must contain at least one item', Http::STATUS_BAD_REQUEST);
		}

		$contentKey = $this->createLibraryTemplateContentKey($normalizedItems);
		foreach ($current['templates'] as $template) {
			if ($this->createLibraryTemplateContentKey($template['items']) === $contentKey) {
				throw new RuntimeException('Library template with same items already exists', Http::STATUS_CONFLICT);
			}
		}

		$this->writeUserTemplate($templateFolder, $normalizedName, $normalizedItems);

		return [
			'templateName' => $normalizedName,
			'scope' => self::USER_SCOPE,
			'items' => $normalizedItems,
		];
	}

	/**
	 * @return array{templates: array<int, array{templateName: string, scope: string, items: array}>, loadedFiles: array<string, string>}
	 *
	 * @throws NotPermittedException
	 * @throws GenericFileException
	 * @throws LockedException
	 */
	private function listUserTemplates(string $uid): array {
		$templateFolder = $this->getUserTemplateFolder($uid);
		$templates = [];
		$loadedFiles = [];

		foreach ($templateFolder->getDirectoryListing() as $node) {
			if (!$node instanceof File || !$this->isLibraryFileName($node->getName())) {
				continue;
			}

			$templateName = $this->stripLibraryExtension($node->getName());
			$loadedFiles[$this->toCaseKey($templateName)] = $node->getName();
			$items = $this->parseLibraryContent($node->getContent());
			if ($items === null) {
				$this->logger->warning('Skipping malformed whiteboard library template', [
					'uid' => $uid,
					'file' => $node->getName(),
				]);
				continue;
			}

			$templates[] = [
				'templateName' => $templateName,
				'scope' => self::USER_SCOPE,
				'items' => $items,
			];
		}

		usort($templates, function (array $left, array $right): int {
			return $this->sortTemplates($left, $right);
		});

		return [
			'templates' => $templates,
			'loadedFiles' => $loadedFiles,
		];
	}

	/**
	 * @return array{templates: array<int, array{templateName: string, scope: string, items: array}>, loadedFiles: array<string, string>, files: array<string, File>}
	 *
	 * @throws NotPermittedException
	 * @throws GenericFileException
	 * @throws LockedException
	 */
	private function listGlobalTemplates(): array {
		$templateFolder = $this->getGlobalTemplateFolder();
		$templates = [];
		$loadedFiles = [];
		$files = [];

		foreach ($templateFolder->getDirectoryListing() as $node) {
			if (!$node instanceof File || !$this->isLibraryFileName($node->getName())) {
				continue;
			}

			$templateName = $this->stripLibraryExtension($node->getName());
			$caseKey = $this->toCaseKey($templateName);
			$loadedFiles[$caseKey] = $node->getName();
			$items = $this->parseLibraryContent($node->getContent());
			if ($items === null) {
				$this->logger->warning('Skipping malformed organization whiteboard library template', [
					'file' => $node->getName(),
				]);
				continue;
			}

			$templates[] = [
				'templateName' => $templateName,
				'scope' => self::GLOBAL_SCOPE,
				'items' => $items,
			];
			$files[$caseKey] = $node;
		}

		usort($templates, function (array $left, array $right): int {
			return $this->sortTemplates($left, $right);
		});

		return [
			'templates' => $templates,
			'loadedFiles' => $loadedFiles,
			'files' => $files,
		];
	}

	/**
	 * @throws NotPermittedException
	 */
	private function getUserTemplateFolder(string $uid): Folder {
		$userFolder = $this->rootFolder->getUserFolder($uid);
		$configuredPath = $this->normalizeTemplatePath(
			$this->config->getUserValue($uid, 'core', 'templateDirectory', '')
		);
		$templateFolder = $configuredPath !== null
			? $this->getExistingFolder($userFolder, $configuredPath)
			: null;

		if (!$templateFolder instanceof Folder) {
			$templatePath = $this->templateManager->initializeTemplateDirectory(self::DEFAULT_TEMPLATE_DIR, $uid, false);
			$templateFolder = $this->ensureFolder($userFolder, $this->normalizeTemplatePath($templatePath) ?? self::DEFAULT_TEMPLATE_DIR);
		}

		$this->migrateRootPersonalTemplate($userFolder, $templateFolder);

		return $templateFolder;
	}

	private function getExistingFolder(Folder $userFolder, string $path): ?Folder {
		try {
			if (!$userFolder->nodeExists($path)) {
				return null;
			}
			$node = $userFolder->get($path);
			return $node instanceof Folder ? $node : null;
		} catch (Exception) {
			return null;
		}
	}

	/**
	 * @throws NotPermittedException
	 */
	private function getGlobalTemplateFolder(): Folder {
		$instanceId = $this->config->getSystemValueString('instanceid', '');
		if ($instanceId === '') {
			throw new RuntimeException('No instance id configured');
		}

		$appDataRoot = $this->ensureChildFolder($this->rootFolder, 'appdata_' . $instanceId);
		$appFolder = $this->ensureChildFolder($appDataRoot, 'whiteboard');
		return $this->ensureChildFolder($appFolder, self::GLOBAL_TEMPLATE_DIR);
	}

	/**
	 * @throws NotPermittedException
	 */
	private function ensureChildFolder(Folder $folder, string $name): Folder {
		if (!$folder->nodeExists($name)) {
			$folder->newFolder($name);
		}

		$node = $folder->get($name);
		if (!$node instanceof Folder) {
			throw new RuntimeException('Expected folder at ' . $name);
		}
		return $node;
	}

	/**
	 * @throws NotPermittedException
	 */
	private function ensureFolder(Folder $userFolder, string $path): Folder {
		$normalizedPath = $this->normalizeTemplatePath($path) ?? trim(self::DEFAULT_TEMPLATE_DIR, '/');
		if (!$userFolder->nodeExists($normalizedPath)) {
			$userFolder->newFolder($normalizedPath);
		}
		$folder = $userFolder->get($normalizedPath);
		if (!$folder instanceof Folder) {
			throw new RuntimeException('Template path is not a folder');
		}
		return $folder;
	}

	private function migrateRootPersonalTemplate(Folder $userFolder, Folder $templateFolder): void {
		$fileName = $this->toLibraryFileName(self::PERSONAL_TEMPLATE);
		try {
			if (!$userFolder->nodeExists($fileName)) {
				return;
			}
			if ($templateFolder->nodeExists($fileName)) {
				$this->logger->info('Leaving root personal whiteboard library in place because target exists');
				return;
			}

			$source = $userFolder->get($fileName);
			if (!$source instanceof File) {
				return;
			}
			if ($this->parseLibraryContent($source->getContent()) === null) {
				$this->logger->warning('Leaving malformed root personal whiteboard library in place');
				return;
			}

			$targetPath = $templateFolder->getPath() . '/' . $fileName;
			try {
				$source->move($targetPath);
				return;
			} catch (Exception $e) {
				$this->logger->warning('Failed to move root personal whiteboard library, trying copy/delete', [
					'exception' => $e->getMessage(),
				]);
			}

			try {
				$source->copy($targetPath);
				$source->delete();
			} catch (Exception $e) {
				$this->logger->warning('Failed to migrate root personal whiteboard library', [
					'exception' => $e->getMessage(),
				]);
				$this->deleteTargetCopyAfterFailedMigration($templateFolder, $fileName);
			}
		} catch (Exception $e) {
			$this->logger->warning('Failed to inspect root personal whiteboard library', [
				'exception' => $e->getMessage(),
			]);
		}
	}

	private function deleteTargetCopyAfterFailedMigration(Folder $templateFolder, string $fileName): void {
		try {
			if ($templateFolder->nodeExists($fileName)) {
				$node = $templateFolder->get($fileName);
				if ($node instanceof File) {
					$node->delete();
				}
			}
		} catch (Exception) {
		}
	}

	/**
	 * @throws JsonException
	 */
	private function writeUserTemplate(Folder $templateFolder, string $templateName, array $items): void {
		$this->writeLibraryTemplate($templateFolder, $templateName, $items);
	}

	/**
	 * @throws JsonException
	 */
	private function writeLibraryTemplate(Folder $templateFolder, string $templateName, array $items): void {
		$fileName = $this->toLibraryFileName($templateName);
		$encoded = $this->encodeLibraryFile($items);
		$file = $templateFolder->nodeExists($fileName)
			? $templateFolder->get($fileName)
			: $templateFolder->newFile($fileName);

		if (!$file instanceof File) {
			throw new GenericFileException('Failed to create or get file: ' . $fileName);
		}

		$file->putContent($encoded);
	}

	/**
	 * @throws JsonException
	 */
	private function encodeLibraryFile(array $items): string {
		$fileData = [
			'type' => 'excalidrawlib',
			'version' => 2,
			'libraryItems' => $this->normalizeLibraryItems($items),
		];
		$encoded = json_encode($fileData, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT);
		if ($this->parseLibraryContent($encoded) === null) {
			throw new InvalidArgumentException('Generated library file is invalid', Http::STATUS_BAD_REQUEST);
		}
		return $encoded;
	}

	private function parseLibraryContent(string $content): ?array {
		try {
			$data = json_decode($content, true, 512, JSON_THROW_ON_ERROR);
		} catch (JsonException) {
			return null;
		}

		if (!is_array($data)) {
			return null;
		}

		if (array_key_exists('libraryItems', $data)) {
			return is_array($data['libraryItems']) ? $this->normalizeLibraryItems($data['libraryItems']) : null;
		}

		if (array_key_exists('library', $data)) {
			return is_array($data['library']) ? $this->normalizeLegacyLibraryItems($data['library']) : null;
		}

		if ($this->isListArray($data)) {
			return $this->normalizeLibraryItems($data);
		}

		return null;
	}

	private function normalizeLegacyLibraryItems(array $libraries): array {
		$items = [];
		foreach ($libraries as $elements) {
			if (!is_array($elements) || count($elements) === 0) {
				continue;
			}
			$items[] = [
				'id' => $this->createLibraryItemId($elements),
				'created' => $this->nowMs(),
				'status' => 'published',
				'elements' => array_values($elements),
			];
		}
		return $this->normalizeLibraryItems($items);
	}

	private function normalizeLibraryItems(array $items): array {
		$normalized = [];
		$seen = [];
		foreach ($items as $item) {
			if (!is_array($item) || !isset($item['elements']) || !is_array($item['elements']) || count($item['elements']) === 0) {
				continue;
			}
			unset($item['templateName'], $item['scope'], $item['filename'], $item['basename']);
			$item['elements'] = array_values($item['elements']);
			$contentKey = $this->createLibraryItemId($item['elements']);
			if (isset($seen[$contentKey])) {
				continue;
			}
			$seen[$contentKey] = true;
			$item['id'] = isset($item['id']) && is_string($item['id']) && $item['id'] !== ''
				? $item['id']
				: $contentKey;
			$item['created'] = isset($item['created']) && is_numeric($item['created'])
				? (int)$item['created']
				: $this->nowMs();
			$item['status'] = isset($item['status']) && is_string($item['status'])
				? $item['status']
				: 'unpublished';
			$normalized[] = $item;
		}
		return $normalized;
	}

	private function normalizePayloadTemplates(array $templates, array $loadedFiles): array {
		$normalized = [];
		$seen = [];

		foreach ($templates as $template) {
			if (!is_array($template)) {
				throw new InvalidArgumentException('Invalid library template payload', Http::STATUS_BAD_REQUEST);
			}
			if (isset($template['scope']) && $template['scope'] !== 'user') {
				throw new InvalidArgumentException('Only user library templates can be updated here', Http::STATUS_BAD_REQUEST);
			}
			if (!isset($template['templateName']) || !is_string($template['templateName'])) {
				throw new InvalidArgumentException('Library templateName is required', Http::STATUS_BAD_REQUEST);
			}

			$templateName = $this->normalizeTemplateName($template['templateName']);
			$caseKey = $this->toCaseKey($templateName);
			if ($caseKey !== self::PERSONAL_TEMPLATE) {
				throw new InvalidArgumentException('Only the personal library template can be updated here', Http::STATUS_BAD_REQUEST);
			}
			if (isset($seen[$caseKey])) {
				throw new RuntimeException('Duplicate library template name', Http::STATUS_CONFLICT);
			}
			$seen[$caseKey] = true;
			$normalizedName = isset($loadedFiles[$caseKey])
				? $this->stripLibraryExtension($loadedFiles[$caseKey])
				: $templateName;
			$templateItems = $template['items'] ?? [];
			$normalized[$normalizedName] = $this->normalizeLibraryItems(is_array($templateItems) ? $templateItems : []);
		}

		return $normalized;
	}

	private function normalizeTemplateName(string $templateName): string {
		$name = trim($templateName);
		if ($this->isLibraryFileName($name)) {
			$name = trim($this->stripLibraryExtension($name));
		}

		if ($name === '' || $name === '.' || $name === '..') {
			throw new InvalidArgumentException('Invalid library template name', Http::STATUS_BAD_REQUEST);
		}
		if (str_contains($name, '/') || str_contains($name, '\\') || preg_match('/[\x00-\x1F\x7F]/', $name) === 1) {
			throw new InvalidArgumentException('Invalid library template name', Http::STATUS_BAD_REQUEST);
		}

		$fileName = $this->toLibraryFileName($name);
		if (strlen($fileName) > self::MAX_FILENAME_BYTES) {
			throw new InvalidArgumentException('Library template name is too long', Http::STATUS_BAD_REQUEST);
		}

		try {
			$this->filenameValidator->validateFilename($fileName);
		} catch (Exception $e) {
			throw new InvalidArgumentException('Invalid library template name: ' . $e->getMessage(), Http::STATUS_BAD_REQUEST, $e);
		}

		return $name;
	}

	private function assertGlobalTemplateNameAllowed(string $templateName): void {
		$caseKey = $this->toCaseKey($templateName);
		if ($caseKey === self::PERSONAL_TEMPLATE || $caseKey === self::BOARD_TEMPLATE) {
			throw new InvalidArgumentException('Reserved library template name', Http::STATUS_BAD_REQUEST);
		}
	}

	private function normalizeTemplatePath(string $path): ?string {
		$normalized = trim($path, '/');
		return $normalized === '' ? null : $normalized;
	}

	private function toLibraryFileName(string $templateName): string {
		return $templateName . self::LIB_EXTENSION;
	}

	private function isLibraryFileName(string $fileName): bool {
		return str_ends_with(strtolower($fileName), self::LIB_EXTENSION);
	}

	private function stripLibraryExtension(string $fileName): string {
		return substr($fileName, 0, -strlen(self::LIB_EXTENSION));
	}

	private function toCaseKey(string $value): string {
		return strtolower($value);
	}

	private function createLibraryItemId(array $elements): string {
		$canonicalElements = $this->canonicalizeLibraryValue($elements);
		$encoded = json_encode($canonicalElements);
		return substr(hash('sha256', $encoded !== false ? $encoded : serialize($canonicalElements)), 0, 20);
	}

	private function createLibraryTemplateContentKey(array $items): string {
		$itemKeys = [];
		foreach ($items as $item) {
			if (!is_array($item) || !isset($item['elements']) || !is_array($item['elements'])) {
				continue;
			}
			$itemKeys[] = $this->createLibraryItemId($item['elements']);
		}
		sort($itemKeys);
		return hash('sha256', implode("\n", $itemKeys));
	}

	private function canonicalizeLibraryValue(mixed $value): mixed {
		if (!is_array($value)) {
			return $value;
		}

		if ($this->isListArray($value)) {
			return array_map(fn ($item) => $this->canonicalizeLibraryValue($item), $value);
		}

		ksort($value);
		$normalized = [];
		foreach ($value as $key => $item) {
			if (is_string($key) && isset(self::VOLATILE_ELEMENT_KEYS[$key])) {
				continue;
			}
			$normalized[$key] = $this->canonicalizeLibraryValue($item);
		}
		return $normalized;
	}

	private function nowMs(): int {
		return (int)floor((float)microtime(true) * 1000.0);
	}

	private function isListArray(array $value): bool {
		return $value === [] || array_keys($value) === range(0, count($value) - 1);
	}

	private function sortTemplates(array $left, array $right): int {
		return strcasecmp($left['templateName'], $right['templateName']);
	}
}
