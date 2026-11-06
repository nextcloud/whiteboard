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
		return $row === null ? null : new BoardState($fileId, $row['epoch'], $row['rev'], $row['digest'], $row['etag'], $row['pending_digest'], $row['pending_epoch'], $row['pending_at'], $row['outside_write'] === 1);
	}

	public function create(int $fileId, string $epoch, int $rev, string $digest, ?string $etag): BoardState {
		$this->rows[$fileId] ??= ['epoch' => $epoch, 'rev' => $rev, 'digest' => $digest, 'etag' => $etag, 'pending_digest' => null, 'pending_epoch' => null, 'pending_at' => null, 'outside_write' => 0];
		return $this->find($fileId);
	}

	/** Runs after each successful change, as another request would */
	public ?\Closure $afterUpdate = null;

	public function update(int $fileId, int $from, int $rev, array $values): bool {
		if (($this->rows[$fileId]['rev'] ?? null) !== $from) {
			return false;
		}
		$this->rows[$fileId] = ['rev' => $rev] + $values + $this->rows[$fileId];
		if ($this->afterUpdate !== null) {
			($this->afterUpdate)($values);
		}
		return true;
	}

	public function flagOutsideWrite(int $fileId): void {
		if (isset($this->rows[$fileId])) {
			$this->rows[$fileId]['outside_write'] = 1;
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
		$this->file->method('putContent')->willReturnCallback(function (string $bytes): void {
			if ($this->beforeWrite !== null) {
				($this->beforeWrite)();
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
		$this->makeService = fn (ILockingProvider $locking) => new BoardSyncService(
			new WhiteboardContentService(new ConfigService($appConfig, $this->createMock(IConfig::class))),
			$this->states,
			$locking,
			$random,
			$time,
			$cacheFactory,
		);
		$this->service = $this->serviceWithLocking(new MemoryLockingProvider());
	}

	private function serviceWithLocking(ILockingProvider $locking): BoardSyncService {
		return ($this->makeService)($locking);
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

	public function testASaveThatChangesNothingWritesNothing(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$saved = $this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 3)], [], $this->actor());

		$again = $this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 3), $this->box('a', 1)], [], $this->actor());

		$this->assertSame(1, $this->writes);
		$this->assertSame($saved['sync'], $again['sync']);
	}

	public function testASaveFromAnotherEpochIsRefused(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->service->replace($this->file, ['elements' => [$this->box('v', 1)], 'files' => []]);

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

	public function testAnOutsideWriteBetweenReadAndWriteIsNotOverwrittenSilently(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->beforeWrite = function (): void {
			$this->beforeWrite = null;
			$this->bytes = json_encode(['elements' => [$this->box('uploaded', 1)]]);
			$this->states->flagOutsideWrite(42);
		};
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());

		$read = $this->service->read($this->file, $sync['epoch'], $sync['rev'] + 1);
		$this->assertNotSame($sync['epoch'], $read['sync']['epoch']);
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

	public function testAWriteStillOnItsWayMakesTheBoardBusy(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->states->rows[42]['pending_digest'] = str_repeat('a', 64);
		$this->states->rows[42]['pending_at'] = $this->now;

		$this->expectException(BoardBusyException::class);
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
	}

	public function testAReservationWhoseBytesLookLikeTheOldOnesKeepsTheBoardBusy(): void {
		// Restoring the same board again: the new bytes are the old ones
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->states->rows[42]['pending_digest'] = $this->states->rows[42]['digest'];
		$this->states->rows[42]['pending_at'] = $this->now;

		$this->expectException(BoardBusyException::class);
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('b', 1)], [], $this->actor());
	}

	public function testHalfWrittenBytesOfAReservationAreNotTakenForAnOutsideWrite(): void {
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
		$this->service = $this->serviceWithLocking($this->createMock(ILockingProvider::class));
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
		$this->service = $this->serviceWithLocking($this->createMock(ILockingProvider::class));
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
		$this->whileReading = function () use ($outside): void {
			$this->bytes = $outside;
		};
		$sync = $this->service->read($this->file, null, null)['sync'];

		$read = $this->service->read($this->file, $sync['epoch'], $sync['rev']);

		$this->assertNotSame($sync['epoch'], $read['sync']['epoch']);
		$this->assertSame(['b'], array_column($read['data']['elements'], 'id'));
	}

	public function testAnAbandonedReservationIsDropped(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->states->rows[42]['pending_digest'] = str_repeat('a', 64);
		$this->states->rows[42]['pending_at'] = $this->now;
		$this->now += 3600;

		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());

		$this->assertSame(['a@1'], $this->stored());
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
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('b', 1)], [], $this->actor());
		$this->cache->remove(42 . '/' . $sync['epoch'] . '/' . ($sync['rev'] + 1));

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
		$this->service = $this->serviceWithLocking($this->createMock(ILockingProvider::class));
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

	public function testRestoreWritesTheVersionAsIsInANewEpoch(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 50)], [], $this->actor());

		$restored = $this->service->replace($this->file, ['elements' => [$this->box('a', 2)], 'files' => []]);

		$this->assertNotSame($sync['epoch'], $restored['sync']['epoch']);
		$this->assertSame(['a@2'], $this->stored());
	}

	/** @return list<string> */
	private function stored(): array {
		return array_map(static fn (array $element) => $element['id'] . '@' . $element['version'], json_decode($this->bytes, true)['elements']);
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
