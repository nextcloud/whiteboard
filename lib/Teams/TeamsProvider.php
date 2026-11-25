<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Teams;

use InvalidArgumentException;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IFilenameValidator;
use OCP\Files\IRootFolder;
use OCP\Files\ISetupManager;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;
use OCP\IL10N;
use OCP\IURLGenerator;
use OCP\IUserSession;
use OCP\Teams\ITeamAppProvider;
use OCP\Teams\ITeamManager;
use OCP\Teams\ITeamResourceProvider;
use OCP\Teams\TeamFolder;
use OCP\Teams\TeamResource;

class TeamsProvider implements ITeamAppProvider, ITeamResourceProvider {
	public function __construct(
		private IURLGenerator $urlGenerator,
		private IRootFolder $root,
		private ISetupManager $fileSetup,
		private IFilenameValidator $filenames,
		private IL10N $l10n,
		private ITeamManager $teamManager,
		private IUserSession $userSession,
	) {
	}

	public function getId(): string {
		return 'whiteboard';
	}

	public function getName(): string {
		return $this->l10n->t('Whiteboard');
	}

	public function getIconSvg(): string {
		return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M3 3H21V17H13V19H17V21H7V19H11V17H3V3M5 5V15H19V5H5Z"/></svg>';
	}

	public function getSharedWith(string $teamId): array {
		$userId = $this->userSession->getUser()?->getUID();
		if ($userId === null || $this->teamManager->getTeam($teamId, $userId) === null) {
			return [];
		}
		$folder = $this->teamManager->getTeamFolderProvider()?->getTeamFolder($teamId);
		try {
			return $this->resources($userId, $folder);
		} catch (NotFoundException|NotPermittedException) {
			return [];
		}
	}

	public function isSharedWithTeam(string $teamId, string $resourceId): bool {
		foreach ($this->getSharedWith($teamId) as $resource) {
			if ($resource->getId() === $resourceId) {
				return true;
			}
		}
		return false;
	}

	public function getTeamsForResource(string $resourceId): array {
		$userId = $this->userSession->getUser()?->getUID();
		if ($userId === null) {
			return [];
		}
		$teamIds = [];
		foreach ($this->teamManager->getTeamsForUser($userId) as $team) {
			if ($this->isSharedWithTeam($team->getId(), $resourceId)) {
				$teamIds[] = $team->getId();
			}
		}
		return $teamIds;
	}

	public function getNavigationResources(string $teamId, string $userId, bool $isAdmin, ?TeamFolder $folder): array {
		return $this->resources($userId, $folder);
	}

	public function canAddResource(string $teamId, string $userId, bool $isAdmin, ?TeamFolder $folder): bool {
		return $isAdmin && $folder !== null && $this->teamFolder($userId, $folder)->isCreatable();
	}

	/** @return list<TeamResource> */
	private function resources(string $userId, ?TeamFolder $folder): array {
		return array_map(function (File $board): TeamResource {
			$id = (string)$board->getId();
			$url = $this->urlGenerator->linkToRouteAbsolute('files.view.showFile', ['fileid' => $id]);
			$referenceUrl = $this->urlGenerator->getAbsoluteURL('/f/' . $id);
			return new TeamResource($this, $id, substr($board->getName(), 0, -11), $url, referenceUrl: $referenceUrl);
		}, $this->boards($userId, $folder));
	}

	public function addResource(string $teamId, string $teamName, string $userId, bool $isAdmin, ?TeamFolder $folder): string {
		if (!$isAdmin) {
			throw new NotPermittedException('Team administration required');
		}
		$folder = $this->teamFolder($userId, $folder);
		if (!$folder->isCreatable()) {
			throw new NotPermittedException('Team folder is not writable');
		}
		$name = $folder->getNonExistingName($this->name($this->l10n->t('New whiteboard')) . '.whiteboard');
		if ($folder->nodeExists($name)) {
			throw new InvalidArgumentException('Whiteboard already exists');
		}
		$board = $folder->newFile($name, '');
		return (string)$board->getId();
	}

	private function teamFolder(string $userId, ?TeamFolder $folderInfo): Folder {
		if ($folderInfo === null) {
			throw new NotFoundException('Team has no folder');
		}
		$userFolder = $this->root->getUserFolder($userId);
		// New team mounts may not yet be present in the user's mount cache.
		$this->fileSetup->setupForPath($userFolder->getPath(), true);
		$mountPoint = ltrim($folderInfo->getMountPoint(), '/');
		$userFolderPath = trim($userFolder->getPath(), '/');
		if ($userFolderPath !== '' && str_starts_with($mountPoint, $userFolderPath . '/')) {
			$mountPoint = substr($mountPoint, strlen($userFolderPath) + 1);
		}
		$folder = $userFolder->get($mountPoint);
		if (!$folder instanceof Folder) {
			throw new NotFoundException('Team folder not found');
		}
		return $folder;
	}

	private function boards(string $userId, ?TeamFolder $folder): array {
		if ($folder === null) {
			return [];
		}
		$pending = [$this->teamFolder($userId, $folder)];
		$seen = [];
		$boards = [];
		while ($folder = array_pop($pending)) {
			if (isset($seen[$folder->getId()])) {
				continue;
			}
			$seen[$folder->getId()] = true;
			foreach ($folder->getDirectoryListing() as $node) {
				if (!$node->isReadable()) {
					continue;
				}
				if ($node instanceof Folder) {
					$pending[] = $node;
				} elseif ($node instanceof File && str_ends_with(strtolower($node->getName()), '.whiteboard')) {
					$boards[] = $node;
				}
			}
		}
		usort($boards, static fn (File $left, File $right): int => strnatcasecmp($left->getPath(), $right->getPath()));
		return $boards;
	}

	private function name(mixed $value): string {
		if (!is_string($value) || trim($value) === '' || in_array(trim($value), ['.', '..'], true) || !$this->filenames->isFilenameValid(trim($value))) {
			throw new InvalidArgumentException('Invalid whiteboard name');
		}
		return trim($value);
	}
}
