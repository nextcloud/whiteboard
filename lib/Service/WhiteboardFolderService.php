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
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;
use OCP\Files\Template\ITemplateManager;
use OCP\IConfig;
use Psr\Log\LoggerInterface;
use RuntimeException;

/**
 * Folder plumbing and name/scope validation shared by the library and canvas
 * template services: the user's Templates folder, the whiteboard app data
 * tree, and the filename rules both features store files under.
 *
 * @psalm-suppress UndefinedDocblockClass
 * @psalm-suppress UndefinedClass
 * @psalm-suppress MissingDependency
 */
final class WhiteboardFolderService {
	public const SCOPE_PERSONAL = 'personal';
	public const SCOPE_ORG = 'org';

	private const MAX_FILENAME_BYTES = 250;
	private const LONGEST_EXTENSION = '.excalidrawlib';

	/** @var null|callable(string): bool */
	private $isFilenameValid;

	/**
	 * @psalm-suppress PossiblyUnusedMethod
	 */
	public function __construct(
		private ITemplateManager $templateManager,
		private IRootFolder $rootFolder,
		private IConfig $config,
		private LoggerInterface $logger,
		?callable $isFilenameValid = null,
	) {
		$this->isFilenameValid = $isFilenameValid;
	}

	public function hasTemplateDirectory(): bool {
		return $this->templateManager->hasTemplateDirectory();
	}

	/**
	 * @throws NotPermittedException
	 * @throws NotFoundException
	 */
	public function getUserTemplateFolder(string $uid): Folder {
		if (!$this->templateManager->hasTemplateDirectory()) {
			$this->templateManager->initializeTemplateDirectory(null, $uid, false);
		}

		$userFolder = $this->rootFolder->getUserFolder($uid);
		$templatesFolder = $userFolder->get($this->templateManager->getTemplatePath());
		if (!$templatesFolder instanceof Folder) {
			throw new NotFoundException('Templates folder not found for user: ' . $uid);
		}
		return $templatesFolder;
	}

	public function getAppDataFolder(string $dir, bool $create): ?Folder {
		$instanceId = $this->config->getSystemValueString('instanceid', '');
		if ($instanceId === '') {
			return null;
		}

		if (!$create) {
			try {
				$node = $this->rootFolder->get('appdata_' . $instanceId . '/whiteboard/' . $dir);
			} catch (NotFoundException) {
				return null;
			} catch (\Throwable $e) {
				$this->logger->warning('Failed to access whiteboard app data', ['app' => 'whiteboard', 'dir' => $dir, 'exception' => $e]);
				return null;
			}
			return $node instanceof Folder ? $node : null;
		}

		$appDataRoot = $this->ensureChildFolder($this->rootFolder, 'appdata_' . $instanceId);
		$appFolder = $this->ensureChildFolder($appDataRoot, 'whiteboard');
		return $this->ensureChildFolder($appFolder, $dir);
	}

	/**
	 * Whether a ".whiteboard" file is a library pointer — an empty board whose
	 * only purpose is to carry a libraryRef (see WhiteboardLibraryService) —
	 * as opposed to a real board / canvas template. Library pointers and
	 * personal canvas templates share the user's Templates folder, so writers
	 * and deleters of one kind must not touch the other.
	 */
	public function isLibraryPointer(File $file): bool {
		$raw = $file->getContent();
		try {
			$content = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
		} catch (JsonException $e) {
			// A just-created file is empty — that is the expected non-pointer
			// case. Anything else is a corrupt file we are about to treat as
			// an overwritable canvas template, so leave a trace.
			if ($raw !== '') {
				$this->logger->warning('Treating malformed whiteboard file as non-pointer', [
					'app' => 'whiteboard',
					'file' => $file->getName(),
					'exception' => $e,
				]);
			}
			return false;
		}
		return is_array($content)
			&& isset($content['libraryRef']) && is_array($content['libraryRef'])
			&& ($content['elements'] ?? []) === [];
	}

	public function deleteIfExists(?Folder $folder, string $fileName): void {
		if (!$folder instanceof Folder || !$folder->nodeExists($fileName)) {
			return;
		}
		$node = $folder->get($fileName);
		if ($node instanceof File) {
			$node->delete();
		}
	}

	public function normalizeScope(string $scope): string {
		if ($scope !== self::SCOPE_PERSONAL && $scope !== self::SCOPE_ORG) {
			throw new InvalidArgumentException('Invalid scope', Http::STATUS_BAD_REQUEST);
		}
		return $scope;
	}

	public function normalizeName(string $name): string {
		$name = trim($name);
		if (!self::isValidName($name)) {
			throw new InvalidArgumentException(
				strlen($name . self::LONGEST_EXTENSION) > self::MAX_FILENAME_BYTES ? 'Name is too long' : 'Invalid name',
				Http::STATUS_BAD_REQUEST
			);
		}
		return $name;
	}

	/**
	 * Enforce the instance filename policy (admin-forbidden characters,
	 * basenames, extensions) on the final filenames a save will create.
	 * Only write paths call this — resolving or deleting existing files must
	 * keep working even if the admin tightens the policy later. The validator
	 * API only exists on Nextcloud 30+.
	 */
	public function enforceFilenamePolicy(string $name, string ...$extensions): void {
		if (!interface_exists(\OCP\Files\IFilenameValidator::class)) {
			return;
		}
		$isFilenameValid = $this->isFilenameValid;
		if ($isFilenameValid === null) {
			$validator = \OCP\Server::get(\OCP\Files\IFilenameValidator::class);
			$isFilenameValid = static fn (string $filename): bool => $validator->isFilenameValid($filename);
		}
		foreach ($extensions as $extension) {
			if (!$isFilenameValid($name . $extension)) {
				throw new InvalidArgumentException('Invalid name', Http::STATUS_BAD_REQUEST);
			}
		}
	}

	/**
	 * Org templates only surface in the picker via the template provider API,
	 * which exists on Nextcloud 30+ — reject org writes on older servers so
	 * admins cannot create data nothing will ever show.
	 */
	public function assertScopeWritable(string $scope): void {
		if ($scope === self::SCOPE_ORG && \OCP\Util::getVersion()[0] < 30) {
			throw new InvalidArgumentException('Organization templates require Nextcloud 30 or later', Http::STATUS_BAD_REQUEST);
		}
	}

	/**
	 * Non-throwing twin of normalizeName, for callers that must drop invalid
	 * names silently (e.g. board content sanitization).
	 */
	public static function isValidName(string $name): bool {
		if ($name !== trim($name) || $name === '' || $name === '.' || $name === '..') {
			return false;
		}
		if (str_contains($name, '/') || str_contains($name, '\\') || preg_match('/[\x00-\x1F\x7F]/', $name) === 1) {
			return false;
		}
		// Windows-reserved device names break syncing the Templates folder to
		// Windows clients (reserved with or without an extension, any case).
		if (preg_match('/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i', $name) === 1) {
			return false;
		}
		return strlen($name . self::LONGEST_EXTENSION) <= self::MAX_FILENAME_BYTES;
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
}
