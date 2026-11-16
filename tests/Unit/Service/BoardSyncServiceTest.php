<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use OC\Files\Cache\CacheEntry;
use OC\Memcache\ArrayCache;
use OC\ServerNotAvailableException;
use OCA\Whiteboard\Exception\BoardBusyException;
use OCA\Whiteboard\Exception\BoardReplacedException;
use OCA\Whiteboard\Exception\BoardUnreadableException;
use OCA\Whiteboard\Model\BoardState;
use OCA\Whiteboard\Model\User;
use OCP\AppFramework\Services\IAppConfig;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventDispatcher;
use OCP\Files\Cache\ICache;
use OCP\Files\Events\Node\BeforeNodeReadEvent;
use OCP\Files\File;
use OCP\Files\GenericFileException;
use OCP\Files\NotPermittedException;
use OCP\Files\Storage\IStorage;
use OCP\HintException;
use OCP\ICacheFactory;
use OCP\IConfig;
use OCP\IDBConnection;
use OCP\Lock\ILockingProvider;
use OCP\Lock\LockedException;
use OCP\Security\ISecureRandom;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;
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
	// Nextcloud runs no file hooks for a write outside the request's filesystem root, as through another user's public link
	private bool $fileHooks = true;
	private int $sharedFileLocks = 0;
	private int $reads = 0;
	private int $lockedReads = 0;
	// What the unlocked read throws, as Nextcloud's encryption does while a write is under way
	private ?\Throwable $unlockedReadError = null;
	// Whether the storage lets the request read the file, as files_accesscontrol decides
	private bool $storageReadable = true;
	/** @var list<string> the read events and unlocked reads, in order */
	private array $seen = [];
	// The bytes the file cache entry still describes after a write that has not updated it yet; otherwise it follows the bytes, as for writes through Nextcloud
	private ?string $cachedBytes = null;
	private IStorage $storage;
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
		$read = function (): string {
			$this->reads++;
			$bytes = $this->bytes;
			if ($this->whileReading !== null) {
				$whileReading = $this->whileReading;
				$this->whileReading = null;
				$whileReading();
			}
			return $bytes;
		};
		// Through Nextcloud's View, which takes the file's shared lock
		$this->file->method('getContent')->willReturnCallback(function () use ($read): string {
			$this->lockedReads++;
			return $read();
		});
		$this->file->method('isReadable')->willReturn(true);
		$fileCache = $this->createMock(ICache::class);
		$fileCache->method('get')->willReturnCallback(fn (string $path) => $path === 'files/board.whiteboard'
			? new CacheEntry(['etag' => md5($this->cachedBytes ?? $this->bytes), 'size' => strlen($this->cachedBytes ?? $this->bytes), 'mtime' => $this->now])
			: false);
		$this->storage = $this->createMock(IStorage::class);
		$this->storage->method('getCache')->willReturn($fileCache);
		$this->storage->method('file_get_contents')->willReturnCallback(function (string $path) use ($read) {
			$this->seen[] = 'unlocked read';
			if ($this->unlockedReadError !== null) {
				throw $this->unlockedReadError;
			}
			return $path === 'files/board.whiteboard' ? $read() : false;
		});
		$this->storage->method('isReadable')->willReturnCallback(fn (string $path) => $path === 'files/board.whiteboard' && $this->storageReadable);
		$this->file->method('getStorage')->willReturn($this->storage);
		$this->file->method('getInternalPath')->willReturn('files/board.whiteboard');
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
				if ($this->fileHooks) {
					BoardSyncService::guardOwnWrite(['run' => &$run, 'path' => '/board.whiteboard']);
				}
			} catch (\Throwable) {
			}
			if (!$run) {
				return;
			}
			$this->bytes = $bytes;
			$this->writes++;
		});

		$this->file->method('lock')->willReturnCallback(function (int $type): void {
			$this->sharedFileLocks += $type === ILockingProvider::LOCK_SHARED ? 1 : 0;
		});
		$this->file->method('unlock')->willReturnCallback(function (int $type): void {
			$this->sharedFileLocks -= $type === ILockingProvider::LOCK_SHARED ? 1 : 0;
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
		$dispatcher = $this->createMock(IEventDispatcher::class);
		$dispatcher->method('dispatchTyped')->willReturnCallback(function (Event $event): void {
			if ($event instanceof BeforeNodeReadEvent && $event->getNode() === $this->file) {
				$this->seen[] = 'read event';
			}
		});
		$this->makeService = function (ILockingProvider $locking, bool $fileLocking, string $memcacheLocking = '\\OC\\Memcache\\Redis') use ($appConfig, $random, $time, $cacheFactory, $dispatcher): BoardSyncService {
			$config = $this->createMock(IConfig::class);
			$config->method('getSystemValueBool')->willReturnMap([['filelocking.enabled', true, $fileLocking]]);
			$config->method('getSystemValueString')->willReturnMap([['memcache.locking', '', $memcacheLocking]]);
			return new BoardSyncService(
				new WhiteboardContentService($this->createMock(LoggerInterface::class), new ConfigService($appConfig, $this->createMock(IConfig::class))),
				$this->states,
				$locking,
				$random,
				$time,
				$cacheFactory,
				$config,
				$dispatcher,
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
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [['type' => 'image', 'fileId' => 'img'] + $this->box('a', 1)], ['img' => ['id' => 'img', 'dataURL' => 'data:x']], $this->actor());

		$answer = $this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('b', 1)], [], $this->actor());

		$this->assertSame(['a', 'b'], array_column($answer['delta']['elements'], 'id'));
		$this->assertSame(['img'], array_keys((array)$answer['delta']['files']));
		$this->assertSame($sync['rev'] + 2, $answer['sync']['rev']);
	}

	public function testASaveTellsWhichImagesOfTheBoardNextcloudLacks(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		// A tab that missed the deletion of an image Nextcloud dropped since brings it back without the image
		$answer = $this->service->save($this->file, $sync['epoch'], $sync['rev'], [['type' => 'image', 'fileId' => 'img'] + $this->box('i', 5)], [], $this->actor());
		$unchanged = $this->service->save($this->file, $sync['epoch'], $sync['rev'], [['type' => 'image', 'fileId' => 'img'] + $this->box('i', 5)], [], $this->actor());
		$sent = $this->service->save($this->file, $sync['epoch'], $sync['rev'], [], ['img' => ['id' => 'img', 'dataURL' => 'data:x']], $this->actor());

		$this->assertSame(['img'], $answer['missingFiles']);
		$this->assertSame(['img'], $unchanged['missingFiles']);
		$this->assertSame([], $sent['missingFiles']);
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

	public function testAReadThatChangesNothingTakesNoLockOnTheFile(): void {
		// Nextcloud's database locks would keep it until the request ends, which keeps saves from writing
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		$this->lockedReads = 0;
		$this->reads = 0;

		$read = $this->service->read($this->file, null, null);

		$this->assertSame(['a'], array_column($read['data']['elements'], 'id'));
		$this->assertSame(1, $this->reads);
		$this->assertSame(0, $this->lockedReads);
	}

	public static function encryptionErrors(): array {
		return [
			'an encryption header not written yet' => [new HintException('Unable to get header block')],
			'the key server not answering' => [new ServerNotAvailableException('not available')],
		];
	}

	#[DataProvider('encryptionErrors')]
	public function testAReadWhoseUnlockedBytesCannotBeDecryptedTakesTheLockedRead(\Throwable $error): void {
		// Nextcloud's encryption throws on a file a write is under way on
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		$this->unlockedReadError = $error;

		$read = $this->service->read($this->file, null, null);

		$this->assertSame(['a'], array_column($read['data']['elements'], 'id'));
	}

	public function testAReaderTheStorageDeniesGetsNoRecentChanges(): void {
		// files_accesscontrol decides in the storage, which the recent changes would not reach
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		$this->storageReadable = false;

		$this->expectException(NotPermittedException::class);
		$this->service->read($this->file, $sync['epoch'], $sync['rev']);
	}

	public function testAReadWithoutTheLockStillTellsNextcloudTheFileIsRead(): void {
		// admin_audit logs it
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		$this->seen = [];

		$this->service->read($this->file, null, null);

		$this->assertSame(['read event', 'unlocked read'], $this->seen);
	}

	public function testOnlyAReadThatMovesTheBoardOnTakesALock(): void {
		$locking = new class() extends MemoryLockingProvider {
			/** @var list<int> */
			public array $acquired = [];

			public function acquireLock(string $path, int $type, ?string $readablePath = null): void {
				$this->acquired[] = $type;
				parent::acquireLock($path, $type, $readablePath);
			}
		};
		$this->service = ($this->makeService)($locking, true, '');

		// The first read creates the state, the second finds an outside write, the third changes nothing
		$this->service->read($this->file, null, null);
		$this->bytes = json_encode(['type' => 'excalidraw', 'version' => 2, 'elements' => [$this->box('z', 1)], 'files' => []]);
		$this->service->read($this->file, null, null);
		$this->service->read($this->file, null, null);

		$this->assertSame([ILockingProvider::LOCK_EXCLUSIVE, ILockingProvider::LOCK_EXCLUSIVE], $locking->acquired);
	}

	public static function lockingProviders(): array {
		return ['database locking' => [''], 'memcache locking' => ['\\OC\\Memcache\\Redis']];
	}

	#[DataProvider('lockingProviders')]
	public function testReadsDoNotWaitForEachOther(string $memcacheLocking): void {
		$this->service = ($this->makeService)(new MemoryLockingProvider(), true, $memcacheLocking);
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		// Another request reads the board while this one does
		$other = null;
		$this->whileReading = function () use (&$other): void {
			$started = microtime(true);
			$other = [array_column($this->service->read($this->file, null, null)['data']['elements'], 'id'), microtime(true) - $started];
		};

		$read = $this->service->read($this->file, null, null);

		$this->assertSame(['a'], array_column($read['data']['elements'], 'id'));
		$this->assertSame(['a'], $other[0]);
		$this->assertLessThan(1.0, $other[1]);
	}

	public function testAReadLetsASaveInProgressFinishBeforeItReadsTheFile(): void {
		// The save's write needs Nextcloud's exclusive lock on the file, which a read holds while it reads
		$locking = new class() extends MemoryLockingProvider {
			/** @var list<string> */
			public array $paths = [];
			public int $saveEndsAfterChecks = 0;

			public function acquireLock(string $path, int $type, ?string $readablePath = null): void {
				$this->paths[] = $path;
				parent::acquireLock($path, $type, $readablePath);
			}

			public function isLocked(string $path, int $type): bool {
				$locked = parent::isLocked($path, $type);
				if ($locked && $type === self::LOCK_EXCLUSIVE && --$this->saveEndsAfterChecks === 0) {
					$this->releaseLock($path, self::LOCK_EXCLUSIVE);
				}
				return $locked;
			}
		};
		$this->service = $this->serviceWithLocking($locking);
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		$board = $locking->paths[0];
		// Another request is saving the board
		$locking->acquireLock($board, ILockingProvider::LOCK_EXCLUSIVE);
		$locking->saveEndsAfterChecks = 2;
		$readDuringTheSave = null;
		$this->whileReading = function () use ($locking, $board, &$readDuringTheSave): void {
			$readDuringTheSave = $locking->isLocked($board, ILockingProvider::LOCK_EXCLUSIVE);
		};

		$read = $this->service->read($this->file, null, null);

		$this->assertSame(['a'], array_column($read['data']['elements'], 'id'));
		$this->assertFalse($readDuringTheSave);
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

	public function testNoUploadLandsBetweenTheCheckOfASaveAndItsWriteWithoutFileHooks(): void {
		$this->fileHooks = false;
		$sync = $this->service->read($this->file, null, null)['sync'];
		$uploaded = json_encode(['type' => 'excalidraw', 'version' => 2, 'elements' => [$this->box('uploaded', 1)], 'files' => []]);
		// A WebDAV upload or a version restore needs the file's exclusive lock
		$upload = function () use ($uploaded): string {
			if ($this->sharedFileLocks > 0) {
				return 'refused';
			}
			$this->bytes = $uploaded;
			$this->states->flagOutsideWrite(42);
			return 'landed';
		};
		$attempt = null;
		$this->states->afterUpdate = function (array $values) use ($upload, &$attempt): void {
			if (($values['pending_digest'] ?? null) !== null && $attempt === null) {
				$attempt = $upload();
			}
		};

		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());

		$this->assertSame('refused', $attempt);
		$this->assertSame(0, $this->sharedFileLocks);
		$this->assertSame('landed', $upload());
		$read = $this->service->read($this->file, null, null);
		$this->assertSame(['uploaded'], array_column($read['data']['elements'], 'id'));
	}

	public function testASaveReadsTheFileToMergeAndOnceMoreRightBeforeItsWrite(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->reads = 0;

		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());

		$this->assertSame(['a@1'], $this->stored());
		$this->assertSame(2, $this->reads);
	}

	public function testNoUploadLandsWhileASaveMergesItsChanges(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$attempt = null;
		$this->whileReading = function () use (&$attempt): void {
			$attempt = $this->sharedFileLocks > 0 ? 'refused' : 'landed';
		};

		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());

		$this->assertSame('refused', $attempt);
		$this->assertSame(['a@1'], $this->stored());
	}

	public function testAnOutsideWriteBetweenReadAndWriteIsKeptWithoutFileLocking(): void {
		// Nothing keeps an upload out while the save merges, and the check before the write is the only one
		$this->service = $this->serviceWithoutFileLocking();
		$this->fileHooks = false;
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
		$bytes = (new WhiteboardContentService($this->createMock(LoggerInterface::class), new ConfigService($this->createMock(IAppConfig::class), $this->createMock(IConfig::class))))->encode(['x' => 1]);
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

		$read = $this->service->read($this->file, null, null);

		// What the read read, with the revision it belongs to
		$this->assertSame(['a'], array_column($read['data']['elements'], 'id'));
		$this->assertSame($sync['rev'] + 1, $read['sync']['rev']);
		$this->assertSame($sync['epoch'], $read['sync']['epoch']);
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

		$read = $this->service->read($this->file, null, null);

		$this->assertSame(['saved'], array_column($read['data']['elements'], 'id'));
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

	public function testARestoreOfOtherBytesOfTheSameSizeRightBeforeTheWriteIsKept(): void {
		$board = fn (string $id): string => json_encode(['type' => 'excalidraw', 'version' => 2, 'elements' => [$this->box($id, 1)], 'files' => []]);
		$this->bytes = $board('current');
		$sync = $this->service->read($this->file, null, null)['sync'];
		// Files' rollback sets the size, copies the version's bytes and releases its lock; only then
		// touch() updates the ETag and modification time, and its event comes later still
		$this->beforeWrite = function () use ($board): void {
			$this->beforeWrite = null;
			$this->cachedBytes = $this->bytes;
			$this->bytes = $board('restore');
		};

		try {
			$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('saved', 1)], [], $this->actor());
			$this->fail('The save overwrote the restore');
		} catch (BoardReplacedException $e) {
			$this->assertNotSame($sync['epoch'], $e->state->epoch);
		}

		$this->assertSame(['restore@1'], $this->stored());
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
		// The file's shared lock keeps a restore out until the save released it, right before its write
		$this->beforeWrite = function (): void {
			$this->beforeWrite = null;
			$this->restoreVersion();
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
		$locked = function () use (&$locked): void {
			$this->whileReading = $locked;
			throw new LockedException('board.whiteboard');
		};
		$this->whileReading = $locked;

		$this->expectException(BoardBusyException::class);
		$this->service->read($this->file, null, null);
	}

	public function testAFailedWriteReleasesItsReservation(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->beforeWrite = function (): void {
			$this->beforeWrite = null;
			throw new GenericFileException('The storage did not answer');
		};
		try {
			$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
			$this->fail('The failed write was accepted');
		} catch (GenericFileException) {
		}

		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		$this->assertSame(['a@1'], $this->stored());
	}

	public function testASaveWhoseWriteFindsTheFileLockedByReadsKeepsTheBoardAndWritesOnceTheyEnd(): void {
		// With Nextcloud's database locks a read keeps its shared lock on the file until its request ends
		$locking = $this->recordingLocks();
		$this->service = $this->serviceWithLocking($locking);
		$sync = $this->service->read($this->file, null, null)['sync'];
		$locking->paths = [];
		$this->reads = 0;
		$attempts = 0;
		$this->beforeWrite = function () use (&$attempts): void {
			if (++$attempts < 3) {
				throw new LockedException('board.whiteboard');
			}
		};

		$answer = $this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());

		$this->assertSame(['a@1'], $this->stored());
		$this->assertSame(3, $attempts);
		$this->assertCount(1, $locking->paths);
		$this->assertSame(2, $this->reads);
		$this->assertSame($answer['sync']['rev'], $this->states->rows[42]['rev']);
		$this->assertNull($this->states->rows[42]['pending_digest']);
	}

	public function testAnUploadWhileTheWriteWaitsForReadsIsKept(): void {
		$this->fileHooks = false;
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->beforeWrite = function (): void {
			$this->beforeWrite = null;
			$this->bytes = json_encode(['type' => 'excalidraw', 'version' => 2, 'elements' => [$this->box('uploaded', 1)], 'files' => []]);
			throw new LockedException('board.whiteboard');
		};

		try {
			$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
			$this->fail('The save overwrote the upload');
		} catch (BoardReplacedException) {
		}
		$this->assertSame(['uploaded@1'], $this->stored());
	}

	public function testASaveWhoseFileStaysLockedGivesUpAsBusyAndDropsItsReservation(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->beforeWrite = function (): void {
			throw new LockedException('board.whiteboard');
		};

		try {
			$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
			$this->fail('The locked write was accepted');
		} catch (BoardBusyException) {
		}
		$this->assertNull($this->states->rows[42]['pending_digest']);
		$this->assertSame(0, $this->writes);
	}

	public function testAReadThatRacesASaveAfterItsReservationShowsTheWrite(): void {
		$locking = new class() extends MemoryLockingProvider {
			public ?\Closure $saving = null;

			// The save took the board lock right after the read looked
			public function isLocked(string $path, int $type): bool {
				return false;
			}

			public function acquireLock(string $path, int $type, ?string $readablePath = null): void {
				if ($this->saving !== null && $type === self::LOCK_EXCLUSIVE) {
					$saving = $this->saving;
					$this->saving = null;
					$saving();
					throw new LockedException($path);
				}
				parent::acquireLock($path, $type, $readablePath);
			}
		};
		$this->service = $this->serviceWithLocking($locking);
		$sync = $this->service->read($this->file, null, null)['sync'];
		$saved = json_encode(['type' => 'excalidraw', 'version' => 2, 'elements' => [$this->box('new', 1)], 'files' => []]);
		// The save reserved its write; the bytes are still the old ones
		$this->states->update(42, $sync['rev'], $sync['rev'] + 1, ['pending_digest' => hash('sha256', $saved), 'pending_at' => $this->now]);
		// and lands while the read waits for the board
		$locking->saving = function () use ($saved, $sync): void {
			$this->bytes = $saved;
			$this->states->update(42, $sync['rev'] + 1, $sync['rev'] + 1, ['digest' => hash('sha256', $saved), 'pending_digest' => null, 'pending_at' => null]);
		};

		$read = $this->service->read($this->file, null, null);

		$this->assertSame(['new'], array_column($read['data']['elements'], 'id'));
		$this->assertSame($sync['rev'] + 1, $read['sync']['rev']);
	}

	public function testAReadThatReadTheFileWhileASaveReservedAnswersWithWhatItRead(): void {
		$locking = $this->recordingLocks();
		$this->service = $this->serviceWithLocking($locking);
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		$rev = $this->states->rows[42]['rev'];
		$this->whileReading = function () use ($locking, $rev): void {
			// A save takes the board and reserves its write
			$locking->acquireLock($locking->paths[0], ILockingProvider::LOCK_EXCLUSIVE);
			$this->states->update(42, $rev, $rev + 1, ['pending_digest' => str_repeat('0', 64), 'pending_at' => $this->now]);
		};

		$started = microtime(true);
		$read = $this->service->read($this->file, null, null);

		$this->assertSame(['a'], array_column($read['data']['elements'], 'id'));
		$this->assertSame($rev, $read['sync']['rev']);
		$this->assertLessThan(1.0, microtime(true) - $started);
		$this->assertNotNull($this->states->rows[42]['pending_digest']);
	}

	public function testAReadDropsAReservationNoRequestHoldsTheBoardFor(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		// A request reserved a write and died before it wrote, leaving the board lock free
		$this->states->update(42, $sync['rev'], $sync['rev'] + 1, ['pending_digest' => str_repeat('0', 64), 'pending_at' => $this->now]);

		$this->service->read($this->file, null, null);

		$this->assertNull($this->states->rows[42]['pending_digest']);
	}

	public function testAPollWithNothingNewDoesNotReadTheFile(): void {
		$sync = $this->service->read($this->file, null, null)['sync'];
		$this->service->save($this->file, $sync['epoch'], $sync['rev'], [$this->box('a', 1)], [], $this->actor());
		$state = $this->states->find(42);
		$this->file = $this->createMock(File::class);
		$this->file->method('getId')->willReturn(42);
		$this->file->method('getEtag')->willReturn($state->etag);
		$this->file->method('getStorage')->willReturn($this->storage);
		$this->file->method('getInternalPath')->willReturn('files/board.whiteboard');
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
		$this->file->method('getStorage')->willReturn($this->storage);
		$this->file->method('getInternalPath')->willReturn('files/board.whiteboard');
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
