<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use OC\Memcache\ArrayCache;
use OCA\Whiteboard\Exception\BoardBusyException;
use OCA\Whiteboard\Exception\BoardReplacedException;
use OCA\Whiteboard\Exception\BoardUnreadableException;
use OCA\Whiteboard\Model\BoardState;
use OCA\Whiteboard\Model\User;
use OCP\AppFramework\Services\IAppConfig;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\Files\File;
use OCP\Files\GenericFileException;
use OCP\ICacheFactory;
use OCP\IConfig;
use OCP\IDBConnection;
use OCP\Lock\ILockingProvider;
use OCP\Lock\LockedException;
use OCP\Security\ISecureRandom;
use PHPUnit\Framework\MockObject\MockObject;
use Test\TestCase;

/**
 * `whiteboard_sync` rows in memory, with the same compare-and-swap on `rev`
 */
class MemoryBoardStateStore extends BoardStateStore {
	/** @var array<int,array<string,mixed>> */
	public array $rows = [];

	public function find(int $fileId): ?BoardState {
		$row = $this->rows[$fileId] ?? null;
		return $row === null ? null : $this->toState(['file_id' => $fileId] + $row);
	}

	public function create(int $fileId, string $epoch, int $rev, string $digest, ?string $etag): BoardState {
		$this->rows[$fileId] ??= ['epoch' => $epoch, 'rev' => $rev, 'digest' => $digest, 'etag' => $etag, 'pending_digest' => null, 'pending_at' => null, 'outside_write' => 0, 'restored' => 0, 'outside_count' => 0];
		return $this->find($fileId);
	}

	/** Runs after each successful change, as another request would */
	public ?\Closure $afterUpdate = null;

	/** Runs before each change, as a request that notes an outside write right then */
	public ?\Closure $beforeUpdate = null;

	public function update(int $fileId, int $from, int $rev, array $values, ?int $outsideCount = null): bool {
		if ($this->beforeUpdate !== null) {
			$beforeUpdate = $this->beforeUpdate;
			$this->beforeUpdate = null;
			$beforeUpdate();
		}
		if (($this->rows[$fileId]['rev'] ?? null) !== $from || ($outsideCount !== null && $this->rows[$fileId]['outside_count'] !== $outsideCount)) {
			return false;
		}
		$this->rows[$fileId] = ['rev' => $rev] + $values + $this->rows[$fileId];
		if ($this->afterUpdate !== null) {
			($this->afterUpdate)($values);
		}
		return true;
	}

	public function flagOutsideWrite(int $fileId, bool $restore = false): void {
		if (isset($this->rows[$fileId]) && ($restore || $this->rows[$fileId]['outside_write'] === BoardState::OUTSIDE_NONE)) {
			$this->rows[$fileId]['outside_write'] = $restore ? BoardState::OUTSIDE_RESTORE : BoardState::OUTSIDE_WRITE;
			$this->rows[$fileId]['outside_count']++;
		}
	}
}

/**
 * Locks of one request, as Nextcloud's providers keep them
 */
class MemoryLockingProvider implements ILockingProvider {
	/** @var array<string,int> */
	private array $locks = [];

	public function isLocked(string $path, int $type): bool {
		$lock = $this->locks[$path] ?? 0;
		return $type === self::LOCK_EXCLUSIVE ? $lock === -1 : $lock > 0;
	}

	public function acquireLock(string $path, int $type, ?string $readablePath = null): void {
		$lock = $this->locks[$path] ?? 0;
		if ($lock === -1 || ($type === self::LOCK_EXCLUSIVE && $lock > 0)) {
			throw new LockedException($path);
		}
		$this->locks[$path] = $type === self::LOCK_EXCLUSIVE ? -1 : $lock + 1;
	}

	public function releaseLock(string $path, int $type): void {
		if ($type === self::LOCK_EXCLUSIVE || ($this->locks[$path] ?? 0) <= 1) {
			unset($this->locks[$path]);
		} else {
			$this->locks[$path]--;
		}
	}

	public function changeLock(string $path, int $targetType): void {
		$this->locks[$path] = $targetType === self::LOCK_EXCLUSIVE ? -1 : 1;
	}

	public function releaseAll(): void {
		$this->locks = [];
	}
}

class BoardSyncServiceTest extends TestCase {
	private MemoryBoardStateStore $states;
	private string $bytes;
	private int $writes = 0;
	private ?\Closure $beforeWrite = null;
	private ?\Closure $whileReading = null;
	private int $now = 1000;
	private ArrayCache $cache;
	/** @var \Closure(ILockingProvider): BoardSyncService */
	private \Closure $makeService;
	/** @var File&MockObject */
	private File $file;
	private BoardSyncService $service;

	protected function setUp(): void {
		parent::setUp();
		$this->states = new MemoryBoardStateStore($this->createMock(IDBConnection::class));
		$this->bytes = json_encode(['type' => 'excalidraw', 'version' => 2, 'elements' => [], 'files' => []]);
		$this->file = $this->createMock(File::class);
		$this->file->method('getId')->willReturn(42);
		$this->file->method('getContent')->willReturnCallback(function (): string {
			$bytes = $this->bytes;
			if ($this->whileReading !== null) {
				$whileReading = $this->whileReading;
				$this->whileReading = null;
				$whileReading();
			}
			return $bytes;
		});
		$this->file->method('getEtag')->willReturnCallback(fn () => md5($this->bytes));
		$this->file->method('getName')->willReturn('board.whiteboard');
		$this->file->method('putContent')->willReturnCallback(function (string $bytes): void {
			if ($this->beforeWrite !== null) {
				($this->beforeWrite)();
			}
			// As Nextcloud's View: the pre-write hook runs under the file's lock, right before the bytes change;
			// as OC_Hook::emit, an exception of the hook is logged and the write goes on
			$run = true;
			try {
				BoardSyncService::guardOwnWrite(['run' => &$run, 'path' => '/board.whiteboard']);
			} catch (\Throwable) {
			}
			if (!$run) {
				return;
			}
			$this->bytes = $bytes;
			$this->writes++;
		});

		$appConfig = $this->createMock(IAppConfig::class);
		$appConfig->method('getAppValueString')->willReturn('secret');
		$random = $this->createMock(ISecureRandom::class);
		$random->method('generate')->willReturnCallback(static fn () => bin2hex(random_bytes(8)));
		$time = $this->createMock(ITimeFactory::class);
		$time->method('getTime')->willReturnCallback(fn () => $this->now);
		$this->cache = new ArrayCache('whiteboard-changes');
		$cacheFactory = $this->createMock(ICacheFactory::class);
		$cacheFactory->method('createDistributed')->willReturn($this->cache);
		$this->makeService = function (ILockingProvider $locking, bool $fileLocking, string $memcacheLocking = '\\OC\\Memcache\\Redis') use ($appConfig, $random, $time, $cacheFactory): BoardSyncService {
			$config = $this->createMock(IConfig::class);
			$config->method('getSystemValueBool')->willReturnMap([['filelocking.enabled', true, $fileLocking]]);
			$config->method('getSystemValueString')->willReturnMap([['memcache.locking', '', $memcacheLocking]]);
			return new BoardSyncService(
				new WhiteboardContentService(new ConfigService($appConfig, $this->createMock(IConfig::class))),
				$this->states,
				$locking,
				$random,
				$time,
				$cacheFactory,
				$config,
			);
		};
		$this->service = $this->serviceWithLocking(new MemoryLockingProvider());
	}

	private function serviceWithLocking(ILockingProvider $locking): BoardSyncService {
		return ($this->makeService)($locking, true);
	}

	/** Nextcloud whose locks are in the database: reads take the exclusive lock at once */
	private function serviceWithDatabaseLocking(): BoardSyncService {
		return ($this->makeService)(new MemoryLockingProvider(), true, '');
	}

	/** Nextcloud with `filelocking.enabled` off: locks do nothing */
	private function serviceWithoutFileLocking(): BoardSyncService {
		return ($this->makeService)($this->createMock(ILockingProvider::class), false);
	}

	/** Locks that remember which paths the service locked */
	private function recordingLocks(): MemoryLockingProvider {
		return new class() extends MemoryLockingProvider {
			/** @var list<string> */
			public array $paths = [];

			public function acquireLock(string $path, int $type, ?string $readablePath = null): void {
				$this->paths[] = $path;
				parent::acquireLock($path, $type, $readablePath);
			}
		};
	}

	public function testAStaleSaveNeverRemovesOrLowersWhatAnotherSaveStored(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 5), $this->box('b', 1)], [], $this->actor());

		// A tab that loaded the empty board saves an older copy of a and a new element
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 2), $this->box('c', 1)], [], $this->actor());

		$this->assertSame(['a@5', 'b@1', 'c@1'], $this->stored());
	}

	public function testASaveAnswersWithEverythingTheTabMissed(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], ['img' => ['id' => 'img', 'dataURL' => 'data:x']], $this->actor());

		$answer = $this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('b', 1)], [], $this->actor());

		$this->assertSame(['a', 'b'], array_column($answer['delta']['elements'], 'id'));
		$this->assertSame(['img'], array_keys((array)$answer['delta']['files']));
		$this->assertSame($sync['rev'] + 2, $answer['sync']['rev']);
	}

	public function testBoardSettingsAreSavedAndOtherTabsCatchUp(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];

		$saved = $this->service->save($this->file, $sync['epoch'], $sync['rev'], [], [], $this->actor(), false, ['viewBackgroundColor' => '#ffec99']);
		$fromCache = $this->service->read($this->file, $sync['epoch'], $sync['rev']);
		$this->cache->clear();
		$fromFile = $this->service->read($this->file, $sync['epoch'], $sync['rev']);

		$this->assertSame(['viewBackgroundColor' => '#ffec99'], $saved['delta']['settings']);
		$this->assertSame(['viewBackgroundColor' => '#ffec99'], $fromCache['delta']['settings']);
		$this->assertSame(['viewBackgroundColor' => '#ffec99'], $fromFile['delta']['settings']);
		$this->assertSame('#ffec99', json_decode($this->bytes, true)['appState']['viewBackgroundColor']);
	}

	public function testRevisionsTooLargeForClientsInAnUploadedFileAreIgnored(): void {
		$this->bytes = json_encode(['type' => 'excalidraw', 'version' => 2, 'elements' => [$this->box('a', 1)], 'files' => [], 'revisions' => ['elements' => ['a' => PHP_INT_MAX], 'files' => []]]);

		$read = $this->service->read($this->file, null, null);
		$saved = $this->service->save($this->file, $read['sync']['epoch'], $read['sync']['rev'], [$this->box('b', 1)], [], $this->actor());

		$this->assertLessThan(2 ** 53, $read['sync']['rev']);
		$this->assertSame($read['sync']['rev'] + 1, $saved['sync']['rev']);
		$this->assertSame(['a@1', 'b@1'], $this->stored());
	}

	public function testReadsOfABoardDoNotWaitForEachOther(): void {
		$locking = $this->recordingLocks();
		$this->service = $this->serviceWithLocking($locking);
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		// Another request is reading the board
		$board = $locking->paths[0];
		$locking->acquireLock($board, ILockingProvider::LOCK_SHARED);

		$read = $this->service->read($this->file, null, null);

		$this->assertSame(['a'], array_column($read['data']['elements'], 'id'));
		$this->assertTrue($locking->isLocked($board, ILockingProvider::LOCK_SHARED));
	}

	public function testReadsTakeTheExclusiveLockWithDatabaseLocking(): void {
		// Nextcloud's database locks keep shared locks until the request ends, so a read could not move on to the exclusive lock
		$locking = new class() extends MemoryLockingProvider {
			/** @var list<int> */
			public array $acquired = [];

			public function acquireLock(string $path, int $type, ?string $readablePath = null): void {
				$this->acquired[] = $type;
				parent::acquireLock($path, $type, $readablePath);
			}
		};
		$this->service = ($this->makeService)($locking, true, '');

		$this->service->read($this->file, null, null);
		$this->bytes = json_encode(['type' => 'excalidraw', 'version' => 2, 'elements' => [$this->box('z', 1)], 'files' => []]);
		$this->service->read($this->file, null, null);

		$this->assertSame([ILockingProvider::LOCK_EXCLUSIVE, ILockingProvider::LOCK_EXCLUSIVE], $locking->acquired);
	}

	public function testAReadThatFindsAnOutsideWriteStartsTheNewEpochAlone(): void {
		$locking = $this->recordingLocks();
		$this->service = $this->serviceWithLocking($locking);
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->bytes = json_encode(['type' => 'excalidraw', 'version' => 2, 'elements' => [$this->box('z', 1)], 'files' => []]);

		$read = $this->service->read($this->file, null, null);

		$this->assertNotSame($sync['epoch'], $read['sync']['epoch']);
		$this->assertSame($read['sync']['epoch'], $this->states->rows[42]['epoch']);
		$this->assertNotSame([], $locking->paths);
		foreach ($locking->paths as $path) {
			$this->assertFalse($locking->isLocked($path, ILockingProvider::LOCK_SHARED));
			$this->assertFalse($locking->isLocked($path, ILockingProvider::LOCK_EXCLUSIVE));
		}
	}

	public function testASaveAfterAnUploadWithRevisionsNearTheLimitIsStillPassedOn(): void {
		$this->bytes = json_encode(['type' => 'excalidraw', 'version' => 2, 'elements' => [$this->box('a', 1)], 'files' => [], 'revisions' => ['elements' => ['a' => 2 ** 53 - 2], 'files' => []]]);

		$read = $this->service->read($this->file, null, null);
		$saved = $this->service->save($this->file, $read['sync']['epoch'], $read['sync']['rev'], [$this->box('b', 1)], [], $this->actor());

		$this->assertContains('b', array_column($saved['delta']['elements'], 'id'));
		$this->assertLessThan(2 ** 53 - 2, $saved['sync']['rev']);
	}

	public function testASaveThatChangesNothingWritesNothing(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$saved = $this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 3)], [], $this->actor());

		$again = $this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 3), $this->box('a', 1)], [], $this->actor());

		$this->assertSame(1, $this->writes);
		$this->assertSame($saved['sync'], $again['sync']);
	}

	public function testASaveFromAnotherEpochIsRefused(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		// A version restored in Files
		$this->bytes = json_encode(['type' => 'excalidraw', 'version' => 2, 'elements' => [$this->box('v', 1)], 'files' => []]);
		$this->states->flagOutsideWrite(42);

		try {
			$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 9)], [], $this->actor());
			$this->fail('The save was accepted');
		} catch (BoardReplacedException $e) {
			$this->assertNotSame($sync['epoch'], $e->state->epoch);
		}
		$this->assertSame(['v@1'], $this->stored());
	}

	public function testAWriteBySomeoneElseStartsANewEpoch(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		// A version restored in Files, or a WebDAV upload
		$this->bytes = json_encode(['type' => 'excalidraw', 'version' => 2, 'elements' => [$this->box('old', 1)]]);

		$this->expectException(BoardReplacedException::class);
		$this->service->save($this->file, $sync['epoch'], $sync['rev'] + 1, [$this->box('a', 2)], [], $this->actor());
	}

	public function testARestoreWithTheSameBytesStillStartsANewEpoch(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->states->flagOutsideWrite(42);

		$read = $this->service->read($this->file, $sync['epoch'], $sync['rev']);

		$this->assertNotSame($sync['epoch'], $read['sync']['epoch']);
		$this->assertArrayHasKey('data', $read);
	}

	public function testAnOutsideWriteRightBeforeTheWriteIsKept(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		// Lands after the save checked the bytes, before Nextcloud locks the file for the write
		$this->beforeWrite = function (): void {
			$this->beforeWrite = null;
			$this->bytes = json_encode(['elements' => [$this->box('uploaded', 1)]]);
			$this->states->flagOutsideWrite(42);
		};

		try {
			$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
			$this->fail('The save overwrote the upload');
		} catch (BoardReplacedException $e) {
			$this->assertNotSame($sync['epoch'], $e->state->epoch);
		}

		$this->assertSame(['uploaded@1'], $this->stored());
		$this->assertNull($this->states->rows[42]['pending_digest']);
		$read = $this->service->read($this->file, null, null);
		$this->assertSame(['uploaded'], array_column($read['data']['elements'], 'id'));
	}

	public function testAnOutsideWriteBetweenReadAndWriteIsKept(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		$uploaded = json_encode(['type' => 'excalidraw', 'version' => 2, 'elements' => [$this->box('uploaded', 1)], 'files' => []]);
		// A WebDAV upload or a version restore lands right after the save read the board
		$this->whileReading = function () use ($uploaded): void {
			$this->bytes = $uploaded;
		};

		try {
			$this->service->save($this->file, $sync['epoch'], $sync['rev'] + 1, [$this->box('a', 2)], [], $this->actor());
			$this->fail('The save overwrote the upload');
		} catch (BoardReplacedException $e) {
			$this->assertNotSame($sync['epoch'], $e->state->epoch);
		}

		$this->assertSame(['uploaded@1'], $this->stored());
		$read = $this->service->read($this->file, null, null);
		$this->assertSame(['uploaded'], array_column($read['data']['elements'], 'id'));
		$this->assertSame($read['sync']['epoch'], $this->states->rows[42]['epoch']);
	}

	public function testBytesThatAreNotABoardAreOnlyReplacedByARepair(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		$this->bytes = '{"elements": [{"id": "a", "ty';

		try {
			$this->service->read($this->file, null, null);
			$this->fail('The board was read');
		} catch (BoardUnreadableException $e) {
			$state = $e->state;
		}
		try {
			$this->service->save($this->file, $state->epoch, $state->rev, [$this->box('b', 1)], [], $this->actor());
			$this->fail('The cut-off board was overwritten');
		} catch (BoardUnreadableException) {
		}
		$this->assertSame('{"elements": [{"id": "a", "ty', $this->bytes);

		$this->service->save($this->file, $state->epoch, $state->rev, [$this->box('a', 1), $this->box('b', 1)], [], $this->actor(), true);
		$this->assertSame(['a@1', 'b@1'], $this->stored());
	}

	public function testAWriteThatLandedButWasNotRecordedIsKept(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		// The request died after writing, before recording the write
		$this->beforeWrite = function (): void {
			$this->beforeWrite = null;
			throw new \RuntimeException('killed');
		};
		try {
			$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		} catch (\RuntimeException) {
		}
		$bytes = (new WhiteboardContentService(new ConfigService($this->createMock(IAppConfig::class), $this->createMock(IConfig::class))))->encode(['x' => 1]);
		$this->states->rows[42]['pending_digest'] = hash('sha256', $bytes);
		$this->states->rows[42]['pending_at'] = $this->now;
		$this->bytes = $bytes;

		$read = $this->service->read($this->file, $sync['epoch'], 0);

		$this->assertSame($sync['epoch'], $read['sync']['epoch']);
		$this->assertNull($this->states->rows[42]['pending_digest']);
	}

	public function testASaveThatDiedMidWriteDoesNotBlockTheBoardWhileFileLockingIsOn(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		// The request died inside putContent; holding the board lock proves nobody else is writing
		$this->states->rows[42]['pending_digest'] = str_repeat('a', 64);
		$this->states->rows[42]['pending_at'] = $this->now;

		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());

		$this->assertSame(['a@1'], $this->stored());
		$this->assertNull($this->states->rows[42]['pending_digest']);
	}

	public function testAWriteStillOnItsWayMakesTheBoardBusy(): void {
		$this->service = $this->serviceWithoutFileLocking();
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->states->rows[42]['pending_digest'] = str_repeat('a', 64);
		$this->states->rows[42]['pending_at'] = $this->now;

		$this->expectException(BoardBusyException::class);
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
	}

	public function testAReservationWhoseBytesLookLikeTheOldOnesKeepsTheBoardBusy(): void {
		$this->service = $this->serviceWithoutFileLocking();
		// Restoring the same board again: the new bytes are the old ones
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->states->rows[42]['pending_digest'] = $this->states->rows[42]['digest'];
		$this->states->rows[42]['pending_at'] = $this->now;

		$this->expectException(BoardBusyException::class);
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('b', 1)], [], $this->actor());
	}

	public function testHalfWrittenBytesOfAReservationAreNotTakenForAnOutsideWrite(): void {
		$this->service = $this->serviceWithoutFileLocking();
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->states->rows[42]['pending_digest'] = str_repeat('a', 64);
		$this->states->rows[42]['pending_at'] = $this->now;
		$this->bytes = '{"elements": [';

		try {
			$this->service->read($this->file, $sync['epoch'], $sync['rev']);
			$this->fail('The half written board was read');
		} catch (BoardBusyException) {
		}
		$this->assertSame($sync['epoch'], $this->states->rows[42]['epoch']);
	}

	public function testBytesReadWhileAnotherSaveLandsAreNotTakenForAnOutsideWrite(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		// Without Nextcloud's file locking, a save lands between reading the bytes and the row
		$this->service = $this->serviceWithoutFileLocking();
		$this->whileReading = function () use ($sync): void {
			$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('b', 1)], [], $this->actor());
		};

		try {
			$this->service->read($this->file, null, null);
			$this->fail('The bytes from before the other save were read');
		} catch (BoardBusyException) {
		}
		$this->assertSame($sync['epoch'], $this->states->rows[42]['epoch']);
		$this->assertSame(['a@1', 'b@1'], $this->stored());
	}

	public function testTheFirstReadOfABoardIsNotTakenOverByASaveThatLandsMeanwhile(): void {
		// Without Nextcloud's file locking, a save creates the row and lands while the first read has the old bytes
		$this->service = $this->serviceWithoutFileLocking();
		$this->whileReading = function (): void {
			$sync = $this->service->read($this->file, null, null)['sync'];
			$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('saved', 1)], [], $this->actor());
		};

		try {
			$this->service->read($this->file, null, null);
			$this->fail('The bytes from before the other save were read');
		} catch (BoardBusyException) {
		}
		$this->assertSame(['saved@1'], $this->stored());
	}

	public function testAnOutsideWriteDuringTheFirstReadIsFoundByTheNextOne(): void {
		$outside = json_encode(['type' => 'excalidraw', 'version' => 2, 'elements' => [$this->box('b', 1)], 'files' => []]);
		// Uploaded over WebDAV while the first read has the old bytes, before the board has a row to flag
		// (the read that creates the row is the second one: the first, under the shared lock, leaves that to it)
		$this->whileReading = function () use ($outside): void {
			$this->whileReading = function () use ($outside): void {
				$this->bytes = $outside;
			};
		};
		$sync = $this->service->read($this->file, null, null)['sync'];

		$read = $this->service->read($this->file, $sync['epoch'], $sync['rev']);

		$this->assertNotSame($sync['epoch'], $read['sync']['epoch']);
		$this->assertSame(['b'], array_column($read['data']['elements'], 'id'));
	}

	public function testAnAbandonedReservationIsDropped(): void {
		$this->service = $this->serviceWithoutFileLocking();
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->states->rows[42]['pending_digest'] = str_repeat('a', 64);
		$this->states->rows[42]['pending_at'] = $this->now;
		$this->now += 3600;

		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());

		$this->assertSame(['a@1'], $this->stored());
	}

	public function testARestoreOfTheSameBytesDuringASaveStartsANewEpoch(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		// A version restore that copies back exactly the stored bytes lands right before the save writes
		$this->beforeWrite = function (): void {
			$this->beforeWrite = null;
			$this->states->flagOutsideWrite(42);
		};
		try {
			$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
			$this->fail('The save wrote across the restore');
		} catch (BoardReplacedException $e) {
			$this->assertNotSame($sync['epoch'], $e->state->epoch);
		}

		$this->assertSame([], $this->stored());
	}

	public function testARestoreNotedWhileAReadStartsANewEpochMarksAnEpochRestored(): void {
		$this->service->read($this->file, null, null);
		// Files restores a version: the bytes change, and its event lands right before the read moves the board on
		$this->bytes = json_encode(['type' => 'excalidraw', 'version' => 2, 'elements' => [$this->box('z', 1)], 'files' => []]);
		$this->states->beforeUpdate = fn () => $this->states->flagOutsideWrite(42, true);

		try {
			$read = $this->service->read($this->file, null, null);
		} catch (BoardBusyException) {
			$read = $this->service->read($this->file, null, null);
		}

		$this->assertTrue($read['sync']['restored']);
	}

	public function testARestoreNotedRightAfterAReadTookTheBytesMarksTheEpochOfTheRestoredBytes(): void {
		$service = $this->serviceWithDatabaseLocking();
		$service->read($this->file, null, null);
		// Files restores a version after the read took the bytes and before it reads the board's state
		$this->whileReading = $this->restoreVersion(...);

		try {
			$service->read($this->file, null, null);
		} catch (BoardBusyException) {
		}
		$read = $service->read($this->file, null, null);

		$this->assertTrue($read['sync']['restored']);
		$this->assertSame(['z'], array_column($read['data']['elements'], 'id'));
	}

	public function testASecondRestoreNotedRightAfterAReadTookTheBytesMarksTheEpochOfItsBytes(): void {
		$service = $this->serviceWithDatabaseLocking();
		$service->read($this->file, null, null);
		$this->restoreVersion('first');
		$this->whileReading = fn () => $this->restoreVersion('second');

		try {
			$service->read($this->file, null, null);
		} catch (BoardBusyException) {
		}
		$read = $service->read($this->file, null, null);

		$this->assertTrue($read['sync']['restored']);
		$this->assertSame(['second'], array_column($read['data']['elements'], 'id'));
	}

	public function testARestoreNotedWhileAnotherRequestFirstSawTheBoardMarksTheEpochOfTheRestoredBytes(): void {
		$service = $this->serviceWithDatabaseLocking();
		$old = $this->bytes;
		// Another request sees the board first, then Files restores a version, while this read holds the old bytes
		$this->whileReading = function () use ($old): void {
			$this->states->create(42, 'other', 0, hash('sha256', $old), md5($old));
			$this->restoreVersion();
		};

		try {
			$service->read($this->file, null, null);
		} catch (BoardBusyException) {
		}
		$read = $service->read($this->file, null, null);

		$this->assertTrue($read['sync']['restored']);
		$this->assertSame(['z'], array_column($read['data']['elements'], 'id'));
	}

	public function testASaveCancelledByAnUploadDoesNotLeaveTheBoardBusyWithoutFileLocking(): void {
		$service = $this->serviceWithoutFileLocking();
		$sync = $service->read($this->file, null, null)['sync'];
		// An upload lands right before the save writes; a version restore follows while the save looks at the file again
		$this->beforeWrite = function (): void {
			$this->beforeWrite = null;
			$this->bytes = json_encode(['type' => 'excalidraw', 'version' => 2, 'elements' => [$this->box('u', 1)], 'files' => []]);
			$this->states->flagOutsideWrite(42);
			$this->whileReading = function (): void {
				$this->whileReading = $this->restoreVersion(...);
			};
		};

		try {
			$service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		} catch (BoardReplacedException|BoardBusyException) {
		}
		$read = $service->read($this->file, null, null);

		$this->assertTrue($read['sync']['restored']);
		$this->assertSame(['z'], array_column($read['data']['elements'], 'id'));
	}

	public function testARestoreNotedRightAfterASaveCheckedTheBytesMarksTheEpochOfTheRestoredBytes(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		// The save reads the bytes to merge, then again right before its write to check nobody else wrote them
		$this->whileReading = function (): void {
			$this->whileReading = $this->restoreVersion(...);
		};

		try {
			$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		} catch (BoardReplacedException|BoardBusyException) {
		}
		$read = $this->service->read($this->file, null, null);

		$this->assertTrue($read['sync']['restored']);
		$this->assertSame(['z@1'], $this->stored());
	}

	public function testARestoreNotedRightAfterThePreWriteHookFoundAnUploadMarksTheEpochOfTheRestoredBytes(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		// An upload lands right before the save writes; a version restore follows once the hook read the upload
		$this->beforeWrite = function (): void {
			$this->beforeWrite = null;
			$this->bytes = json_encode(['type' => 'excalidraw', 'version' => 2, 'elements' => [$this->box('u', 1)], 'files' => []]);
			$this->states->flagOutsideWrite(42);
			$this->whileReading = $this->restoreVersion(...);
		};

		try {
			$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		} catch (BoardReplacedException|BoardBusyException) {
		}
		$read = $this->service->read($this->file, null, null);

		$this->assertTrue($read['sync']['restored']);
		$this->assertSame(['z@1'], $this->stored());
	}

	public function testASaveThatDidNotKnowALaterSettingLeavesIt(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [], [], $this->actor(), false, ['viewBackgroundColor' => '#0000ff']);

		// A save that started from the board before that change, for example the last save of a board closed in another page
		$answer = $this->service->save($this->file, $sync['epoch'], $sync['rev'], [], [], $this->actor(), false, ['viewBackgroundColor' => '#ff0000']);

		$this->assertSame('#0000ff', json_decode($this->bytes, true)['appState']['viewBackgroundColor']);
		$this->assertSame('#0000ff', $answer['delta']['settings']['viewBackgroundColor'] ?? null);
	}

	public function testAWriteWhoseGuardCannotReadTheFileDoesNotHappen(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$before = $this->bytes;
		$this->beforeWrite = function (): void {
			$this->beforeWrite = null;
			$this->whileReading = function (): void {
				throw new GenericFileException('The storage did not answer');
			};
		};
		try {
			$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
			$this->fail('The save wrote without its check');
		} catch (BoardBusyException) {
		}

		$this->assertSame($before, $this->bytes);
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		$this->assertSame(['a@1'], $this->stored());
	}

	public function testAVersionRestoreStartsAnEpochTabsTakeAsARestore(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->bytes = json_encode(['type' => 'excalidraw', 'version' => 2, 'elements' => [$this->box('old', 1)], 'files' => []]);
		$this->states->flagOutsideWrite(42, true);
		// Files also tells about the write the restore made
		$this->states->flagOutsideWrite(42);

		$read = $this->service->read($this->file, $sync['epoch'], $sync['rev']);

		$this->assertNotSame($sync['epoch'], $read['sync']['epoch']);
		$this->assertTrue($read['sync']['restored']);
	}

	public function testAnUploadStartsAnEpochThatIsNoRestore(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->bytes = json_encode(['type' => 'excalidraw', 'version' => 2, 'elements' => [$this->box('uploaded', 1)], 'files' => []]);
		$this->states->flagOutsideWrite(42);

		$read = $this->service->read($this->file, $sync['epoch'], $sync['rev']);

		$this->assertNotSame($sync['epoch'], $read['sync']['epoch']);
		$this->assertFalse($read['sync']['restored']);
	}

	public function testABoardSomeoneElseIsWritingIsBusy(): void {
		$this->whileReading = function (): void {
			throw new LockedException('board.whiteboard');
		};

		$this->expectException(BoardBusyException::class);
		$this->service->read($this->file, null, null);
	}

	public function testAFailedWriteReleasesItsReservation(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->beforeWrite = function (): void {
			$this->beforeWrite = null;
			throw new LockedException('board.whiteboard');
		};
		try {
			$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
			$this->fail('The locked write was accepted');
		} catch (BoardBusyException) {
		}

		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		$this->assertSame(['a@1'], $this->stored());
	}

	public function testAPollWithNothingNewDoesNotReadTheFile(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		$state = $this->states->find(42);
		$this->file = $this->createMock(File::class);
		$this->file->method('getId')->willReturn(42);
		$this->file->method('getEtag')->willReturn($state->etag);
		$this->file->expects($this->never())->method('getContent');

		$read = $this->service->read($this->file, $state->epoch, $state->rev);

		$this->assertSame([], $read['delta']['elements']);
	}

	public function testATabAFewSavesBehindCatchesUpWithoutAReadOfTheFile(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1), $this->box('b', 1)], ['img' => ['id' => 'img', 'dataURL' => 'data:x']], $this->actor());
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 2)], [], $this->actor());
		$expected = $this->service->read($this->file, $sync['epoch'], $sync['rev']);
		$state = $this->states->find(42);
		$this->file = $this->createMock(File::class);
		$this->file->method('getId')->willReturn(42);
		$this->file->method('getEtag')->willReturn($state->etag);
		$this->file->expects($this->never())->method('getContent');

		$read = $this->service->read($this->file, $sync['epoch'], $sync['rev']);

		$this->assertSame(['a@2', 'b@1'], array_map(static fn (array $element) => $element['id'] . '@' . $element['version'], $read['delta']['elements']));
		$this->assertSame(['img'], array_keys((array)$read['delta']['files']));
		$this->assertEquals($expected, $read);
	}

	public function testATabCatchesUpFromTheFileWhenAWriteIsNotCached(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		$this->cache->clear();
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('b', 1)], [], $this->actor());

		$read = $this->service->read($this->file, $sync['epoch'], $sync['rev']);

		$this->assertSame(['a', 'b'], array_column($read['delta']['elements'], 'id'));
	}

	public function testAWriteBySomeoneElseIsNotHiddenByCachedChanges(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		$this->bytes = json_encode(['type' => 'excalidraw', 'version' => 2, 'elements' => [$this->box('z', 1)], 'files' => []]);

		$read = $this->service->read($this->file, $sync['epoch'], $sync['rev']);

		$this->assertArrayHasKey('data', $read);
		$this->assertNotSame($sync['epoch'], $read['sync']['epoch']);
	}

	public function testASaveAnswersWithTheRevisionItWroteWhenAnotherSaveFollowsAtOnce(): void {
		// Without Nextcloud's file locking, only the compare-and-swap on the row orders the writes
		$this->service = $this->serviceWithoutFileLocking();
		$sync = $this->service->read($this->file, null, null)['sync'];
		$other = true;
		$this->states->afterUpdate = function (array $values) use (&$other, $sync): void {
			if ($other && array_key_exists('digest', $values) && $values['pending_digest'] === null) {
				$other = false;
				$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('b', 1)], [], $this->actor());
			}
		};

		$answer = $this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());

		$this->assertSame($sync['rev'] + 1, $answer['sync']['rev']);
		$this->assertSame(['a@1', 'b@1'], $this->stored());
	}

	public function testASaveFromBeforeTheBytesBrokeIsToldTheBoardWasReplaced(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->bytes = '{"elements": [';

		$this->expectException(BoardReplacedException::class);
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
	}

	public function testATabThatCouldNotReadTheBoardIsNotToldThatNothingChanged(): void {
		$this->bytes = '{"elements": [';
		try {
			$this->service->read($this->file, null, null);
			$this->fail('The board was read');
		} catch (BoardUnreadableException $e) {
			$state = $e->state;
		}

		// The tab asks again from the epoch and revision of that answer
		$this->expectException(BoardUnreadableException::class);
		$this->service->read($this->file, $state->epoch, $state->rev);
	}

	public function testATabThatCouldNotReadABoardSomeoneElseBrokeIsNotToldThatNothingChanged(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		$this->bytes = '{"elements": [';
		try {
			$this->service->read($this->file, $sync['epoch'], $sync['rev'] + 1);
			$this->fail('The board was read');
		} catch (BoardUnreadableException $e) {
			$state = $e->state;
		}

		$this->expectException(BoardUnreadableException::class);
		$this->service->read($this->file, $state->epoch, $state->rev);
	}

	public function testARepairMakesAnUnreadableBoardReadableEvenWithAnEmptyScene(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->bytes = '{"elements": [';
		try {
			$this->service->read($this->file, $sync['epoch'], $sync['rev']);
		} catch (BoardUnreadableException $e) {
			$sync = ['epoch' => $e->state->epoch, 'rev' => $e->state->rev];
		}

		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [], [], $this->actor(), true);

		$this->assertSame([], json_decode($this->bytes, true)['elements']);
	}

	/** @return list<string> */
	private function stored(): array {
		return array_map(static fn (array $element) => $element['id'] . '@' . $element['version'], json_decode($this->bytes, true)['elements']);
	}

	/** Files restores a version of the board: the bytes change, then its event marks the board */
	private function restoreVersion(string $id = 'z'): void {
		$this->bytes = json_encode(['type' => 'excalidraw', 'version' => 2, 'elements' => [$this->box($id, 1)], 'files' => []]);
		$this->states->flagOutsideWrite(42, true);
	}

	private function box(string $id, int $version): array {
		return ['id' => $id, 'type' => 'rectangle', 'version' => $version, 'versionNonce' => $version];
	}

	private function actor(): User {
		$actor = $this->createMock(User::class);
		$actor->method('getUID')->willReturn('alice');
		$actor->method('getDisplayName')->willReturn('Alice');
		return $actor;
	}
}
