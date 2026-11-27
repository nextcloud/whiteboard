<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Listener;

use OCA\Files_Versions\Events\VersionRestoredEvent;
use OCA\Files_Versions\Versions\IVersion;
use OCA\Whiteboard\Service\BoardStateStore;
use OCA\Whiteboard\Service\BoardSyncService;
use OCP\Files\Events\Node\NodeDeletedEvent;
use OCP\Files\Events\Node\NodeWrittenEvent;
use OCP\Files\File;
use OCP\Files\NotFoundException;
use PHPUnit\Framework\MockObject\MockObject;
use Test\TestCase;

class BoardOutsideWriteListenerTest extends TestCase {
	private BoardStateStore&MockObject $states;
	private BoardOutsideWriteListener $listener;

	#[\Override]
	protected function setUp(): void {
		parent::setUp();
		$this->states = $this->createMock(BoardStateStore::class);
		// Built for every file written on the instance: it needs no more than the state store
		$this->listener = new BoardOutsideWriteListener($this->states);
	}

	#[\Override]
	protected function tearDown(): void {
		(new \ReflectionProperty(BoardSyncService::class, 'writing'))->setValue(null, []);
		$this->restoreService(BoardOutsideWriteListener::class);
		parent::tearDown();
	}

	public function testAWriteBySomeoneElseIsFlagged(): void {
		$this->states->expects($this->once())->method('flagOutsideWrite')->with(42);

		$this->listener->handle(new NodeWrittenEvent($this->file(42, 'application/vnd.excalidraw+json')));
	}

	public function testWhiteboardsOwnWriteIsNotFlagged(): void {
		(new \ReflectionProperty(BoardSyncService::class, 'writing'))->setValue(null, [42 => ['file' => $this->file(42, 'application/vnd.excalidraw+json'), 'digest' => '', 'replaced' => static fn (): bool => false, 'outside' => false]]);
		$this->states->expects($this->never())->method('flagOutsideWrite');

		$this->listener->handle(new NodeWrittenEvent($this->file(42, 'application/vnd.excalidraw+json')));
	}

	public function testOtherFilesAreLeftAlone(): void {
		$this->states->expects($this->never())->method('flagOutsideWrite');

		$this->listener->handle(new NodeWrittenEvent($this->file(7, 'text/plain')));
	}

	public function testANodeWithoutFileInformationIsLeftAlone(): void {
		// As Nextcloud's NonExistingFile, which has no file info to read
		$node = $this->createMock(File::class);
		$node->method('getMimetype')->willThrowException(new NotFoundException());
		$node->method('getId')->willThrowException(new NotFoundException());
		$this->states->expects($this->never())->method('flagOutsideWrite');

		$this->listener->handle(new NodeWrittenEvent($node));
	}

	public function testAVersionRestoredInNextcloudStartsANewEpoch(): void {
		if (!class_exists(VersionRestoredEvent::class)) {
			$this->markTestSkipped('Nextcloud 31 sends the rollback hook instead');
		}
		$version = $this->createMock(IVersion::class);
		$version->method('getSourceFile')->willReturn($this->file(42, 'application/vnd.excalidraw+json'));
		$this->states->expects($this->once())->method('flagOutsideWrite')->with(42, true);

		$this->listener->handle(new VersionRestoredEvent($version));
	}

	public function testAVersionRestoredWithTheRollbackHookStartsANewEpoch(): void {
		// Nextcloud 31 resolves the listener from the container for its static hook
		$this->overwriteService(BoardOutsideWriteListener::class, $this->listener);
		$this->states->expects($this->once())->method('flagOutsideWrite')->with(42, true);

		BoardOutsideWriteListener::onRollback(['node' => $this->file(42, 'application/vnd.excalidraw+json')]);
	}

	public function testTheStateOfADeletedBoardIsDropped(): void {
		$this->states->expects($this->once())->method('delete')->with(42);

		$this->listener->handle(new NodeDeletedEvent($this->file(42, 'application/vnd.excalidraw+json')));
	}

	private function file(int $id, string $mimetype): File&MockObject {
		$file = $this->createMock(File::class);
		$file->method('getId')->willReturn($id);
		$file->method('getMimetype')->willReturn($mimetype);
		return $file;
	}
}
