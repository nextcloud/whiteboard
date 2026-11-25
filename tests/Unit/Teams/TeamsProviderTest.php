<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Tests\Teams;

use OCA\Whiteboard\Teams\TeamsProvider;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IFilenameValidator;
use OCP\Files\IRootFolder;
use OCP\Files\ISetupManager;
use OCP\Files\IUserFolder;
use OCP\Files\NotPermittedException;
use OCP\IL10N;
use OCP\IURLGenerator;
use OCP\IUser;
use OCP\IUserSession;
use OCP\Teams\ITeamAppProvider;
use OCP\Teams\ITeamFolderProvider;
use OCP\Teams\ITeamManager;
use OCP\Teams\Team;
use OCP\Teams\TeamFolder;
use OCP\Teams\TeamResource;
use PHPUnit\Framework\TestCase;

final class TeamsProviderTest extends TestCase {
	private function fixture(?ITeamManager $teams = null, ?IUserSession $session = null, ?ISetupManager $fileSetup = null, ?callable $onFolderLookup = null): array {
		$root = $this->createMock(IRootFolder::class);
		$home = $this->createMock(IUserFolder::class);
		$folder = $this->createMock(Folder::class);
		$child = $this->createMock(Folder::class);
		$board = $this->createMock(File::class);
		$root->method('getUserFolder')->with('member')->willReturn($home);
		$home->method('getPath')->willReturn('/member/files');
		$home->method('get')->with('Team')->willReturnCallback(static function () use ($folder, $onFolderLookup) {
			if ($onFolderLookup !== null) {
				$onFolderLookup();
			}
			return $folder;
		});
		$home->method('getRelativePath')->willReturn('/Team/Sub/Sketch.whiteboard');
		$folder->method('getId')->willReturn(1);
		$folder->method('getDirectoryListing')->willReturn([$child]);
		$folder->method('isCreatable')->willReturn(true);
		$child->method('getId')->willReturn(2);
		$child->method('isReadable')->willReturn(true);
		$child->method('getDirectoryListing')->willReturn([$board]);
		$child->method('getPath')->willReturn('/member/files/Team/Sub');
		$board->method('getId')->willReturn(42);
		$board->method('getName')->willReturn('Sketch.whiteboard');
		$board->method('getPath')->willReturn('/member/files/Team/Sub/Sketch.whiteboard');
		$board->method('isReadable')->willReturn(true);
		$filenames = $this->createMock(IFilenameValidator::class);
		$filenames->method('isFilenameValid')->willReturnCallback(static fn (string $name): bool => !str_contains($name, '/'));
		$l10n = $this->createMock(IL10N::class);
		$l10n->method('t')->willReturnArgument(0);
		$urls = $this->createMock(IURLGenerator::class);
		$urls->method('getAbsoluteURL')->willReturnCallback(static fn (string $path): string => 'https://cloud.example' . $path);
		$urls->method('linkToRouteAbsolute')->with('files.view.showFile', ['fileid' => '42'])->willReturn('https://cloud.example/index.php/f/42');
		$provider = new TeamsProvider($urls, $root, $fileSetup ?? $this->createMock(ISetupManager::class), $filenames, $l10n, $teams ?? $this->createMock(ITeamManager::class), $session ?? $this->createMock(IUserSession::class));
		$context = ['team', 'Team', 'member', true, new TeamFolder(1, 'Team')];
		return [$provider, $context, $folder, $board];
	}

	public function testRecursiveDiscoveryAndCreationAvailability(): void {
		[$provider, $context] = $this->fixture();
		$result = $provider->getNavigationResources($context[0], $context[2], $context[3], new TeamFolder(1, '/member/files/Team'));
		$this->assertSame(['42'], array_map(static fn (TeamResource $resource) => $resource->getId(), $result));
		$this->assertSame('https://cloud.example/index.php/f/42', $result[0]->getUrl());
		$this->assertSame('https://cloud.example/f/42', $result[0]->getReferenceUrl());
		$this->assertTrue($provider->canAddResource('team', 'member', true, $context[4]));
		$this->assertFalse($provider->canAddResource('team', 'member', true, null));
		$this->assertFalse($provider->canAddResource('team', 'member', false, $context[4]));
	}

	public function testInitializesUserFilesystemBeforeResolvingTeamFolder(): void {
		$initialized = false;
		$fileSetup = $this->createMock(ISetupManager::class);
		$fileSetup->expects($this->once())->method('setupForPath')->with('/member/files', true)
			->willReturnCallback(static function () use (&$initialized): void {
				$initialized = true;
			});
		[$provider, $context] = $this->fixture(
			fileSetup: $fileSetup,
			onFolderLookup: function () use (&$initialized): void {
				$this->assertTrue($initialized, 'The filesystem must be initialized before looking up the team folder');
			},
		);
		$this->assertCount(1, $provider->getNavigationResources($context[0], $context[2], $context[3], $context[4]));
	}

	public function testResourceProviderOnlyFindsBoardsInAccessibleTeams(): void {
		$user = $this->createMock(IUser::class);
		$user->method('getUID')->willReturn('member');
		$session = $this->createMock(IUserSession::class);
		$session->method('getUser')->willReturn($user);
		$folderProvider = $this->createMock(ITeamFolderProvider::class);
		$folderProvider->expects($this->once())->method('getTeamFolder')->with('team')->willReturn(new TeamFolder(1, 'Team'));
		$teams = $this->createMock(ITeamManager::class);
		$teams->method('getTeam')->willReturnMap([['team', 'member', new Team('team', 'Team', null)], ['other', 'member', null]]);
		$teams->method('getTeamFolderProvider')->willReturn($folderProvider);
		[$provider] = $this->fixture($teams, $session);

		$this->assertTrue($provider->isSharedWithTeam('team', '42'));
		$this->assertFalse($provider->isSharedWithTeam('other', '42'));
	}

	public function testNonadminCannotCreateBoards(): void {
		[$provider, , $folder] = $this->fixture();
		$folder->expects($this->never())->method('newFile');
		$this->expectException(NotPermittedException::class);
		$provider->addResource('team', 'Team', 'member', false, new TeamFolder(1, 'Team'));
	}

	public function testCreateReturnsItsEntryId(): void {
		[$provider, $context, $folder] = $this->fixture();
		$new = $this->createMock(File::class);
		$new->method('getId')->willReturn(43);
		$folder->expects($this->once())->method('getNonExistingName')->with('New whiteboard.whiteboard')->willReturn('New whiteboard.whiteboard');
		$folder->expects($this->once())->method('newFile')->with('New whiteboard.whiteboard', '')->willReturn($new);
		$this->assertSame('43', $provider->addResource(...$context));
	}

	public function testCreateDoesNotOverwriteExistingBoards(): void {
		[$provider, $context, $folder] = $this->fixture();
		$folder->method('getNonExistingName')->with('New whiteboard.whiteboard')->willReturn('New whiteboard.whiteboard');
		$folder->method('nodeExists')->willReturn(true);
		$folder->expects($this->never())->method('newFile');
		$this->expectException(\InvalidArgumentException::class);
		$provider->addResource(...$context);
	}

	public function testPromptlessCreationUsesAnAvailableDefaultName(): void {
		[$provider, $context, $folder] = $this->fixture();
		$new = $this->createMock(File::class);
		$new->method('getId')->willReturn(43);
		$folder->expects($this->once())->method('getNonExistingName')->with('New whiteboard.whiteboard')->willReturn('New whiteboard (2).whiteboard');
		$folder->expects($this->once())->method('newFile')->with('New whiteboard (2).whiteboard', '')->willReturn($new);
		$this->assertSame('43', $provider->addResource(...$context));
	}

	public function testImplementsCoreProviderWithoutLoadingATeamsViewer(): void {
		if (!interface_exists(ITeamAppProvider::class)) {
			$this->markTestSkipped('Requires the core Teams app provider API');
		}
		$urlGenerator = $this->createMock(IURLGenerator::class);
		$urlGenerator->expects($this->never())->method('linkTo');
		$provider = new TeamsProvider($urlGenerator, $this->createMock(IRootFolder::class), $this->createMock(ISetupManager::class), $this->createMock(IFilenameValidator::class), $this->createMock(IL10N::class), $this->createMock(ITeamManager::class), $this->createMock(IUserSession::class));
		$this->assertInstanceOf(ITeamAppProvider::class, $provider);
		$this->assertSame('whiteboard', $provider->getId());
	}
}
