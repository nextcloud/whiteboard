<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use OC\Files\Filesystem;
use OCA\Whiteboard\Exception\BoardReplacedException;
use OCA\Whiteboard\Model\User;
use OCA\Whiteboard\Storage\BoardWriteGuard;
use OCP\EventDispatcher\IEventDispatcher;
use OCP\Files\File;
use OCP\Files\IRootFolder;
use OCP\Files\NotPermittedException;
use OCP\IUserManager;
use OCP\Server;
use OCP\Util;
use PHPUnit\Framework\Attributes\Group;
use Test\TestCase;

/**
 * An app that cancels every write through Nextcloud's file hooks
 */
final class CancellingApp {
	/**
	 * @param array{run: bool} $params
	 */
	public static function cancel(array $params): void {
		$params['run'] = false;
	}
}

/**
 * Saves through Nextcloud's own files, locks and storage wrappers
 */
#[Group('DB')]
class BoardSyncServiceFilesTest extends TestCase {
	private string $userId;
	private File $file;
	private BoardSyncService $service;

	protected function setUp(): void {
		parent::setUp();
		// As the app registers it
		Util::connectHook('OC_Filesystem', 'preSetup', BoardWriteGuard::class, 'register');
		$this->userId = $this->getUniqueID('whiteboard-');
		Server::get(IUserManager::class)->createUser($this->userId, 'whiteboard-test-password');
		self::loginAsUser($this->userId);
		$this->file = Server::get(IRootFolder::class)->getUserFolder($this->userId)->newFile('board.whiteboard', $this->board('existing'));
		$this->service = Server::get(BoardSyncService::class);
	}

	protected function tearDown(): void {
		\OC_Hook::clear('OC_Filesystem');
		Server::get(IUserManager::class)->get($this->userId)?->delete();
		self::logout();
		Filesystem::getLoader()->removeStorageWrapper('whiteboard');
		parent::tearDown();
	}

	public function testAnUploadBetweenTheMergeAndTheWriteIsKeptWithoutFileHooks(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$uploaded = $this->board('uploaded');
		$upload = function () use ($uploaded): void {
			// Another request's upload: the guard checks only the writes of its own request
			$storage = $this->file->getStorage();
			while (!$storage instanceof BoardWriteGuard) {
				$storage = $storage->getWrapperStorage();
			}
			$storage->getWrapperStorage()->file_put_contents($this->file->getInternalPath(), $uploaded);
			$storage->getUpdater()->update($this->file->getInternalPath());
		};
		// File::putContent() sends it after the save let go of the file's lock, before Nextcloud locks the file for the write
		Server::get(IEventDispatcher::class)->addListener('\OCP\Files::preWrite', function () use (&$upload): void {
			$run = $upload;
			$upload = null;
			$run?->__invoke();
		});

		try {
			$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a')], [], $this->actor());
			$this->fail('The save overwrote the upload');
		} catch (BoardReplacedException $e) {
			$this->assertNotSame($sync['epoch'], $e->state->epoch);
		}
		$this->assertSame($uploaded, $this->file->getContent());
	}

	public function testAWriteAnotherAppCancelledIsNotAnsweredAsStored(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		Util::connectHook('OC_Filesystem', 'write', CancellingApp::class, 'cancel');

		try {
			$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a')], [], $this->actor());
			$this->fail('The save answered as stored');
		} catch (NotPermittedException) {
		}
		$this->assertSame($this->board('existing'), $this->file->getContent());

		// The refused save let go of its revision
		\OC_Hook::clear('OC_Filesystem', 'write');
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a')], [], $this->actor());
		$this->assertSame(['existing', 'a'], array_column(json_decode($this->file->getContent(), true)['elements'], 'id'));
	}

	private function board(string $id): string {
		return json_encode(['type' => 'excalidraw', 'version' => 2, 'elements' => [$this->box($id)], 'files' => []]);
	}

	private function box(string $id): array {
		return ['id' => $id, 'type' => 'rectangle', 'version' => 1, 'versionNonce' => 1];
	}

	private function actor(): User {
		$actor = $this->createStub(User::class);
		$actor->method('getUID')->willReturn('alice');
		$actor->method('getDisplayName')->willReturn('Alice');
		return $actor;
	}
}
