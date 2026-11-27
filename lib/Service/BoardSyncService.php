<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use JsonException;
use LogicException;
use OC\ServerNotAvailableException;
use OCA\Whiteboard\Exception\BoardBehindException;
use OCA\Whiteboard\Exception\BoardBusyException;
use OCA\Whiteboard\Exception\BoardReplacedException;
use OCA\Whiteboard\Exception\BoardUnreadableException;
use OCA\Whiteboard\Model\BoardState;
use OCA\Whiteboard\Model\User;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\EventDispatcher\IEventDispatcher;
use OCP\Files\Events\Node\BeforeNodeReadEvent;
use OCP\Files\File;
use OCP\Files\GenericFileException;
use OCP\Files\NotPermittedException;
use OCP\Files\Storage\IStorage;
use OCP\HintException;
use OCP\ICache;
use OCP\ICacheFactory;
use OCP\IConfig;
use OCP\Lock\ILockingProvider;
use OCP\Lock\LockedException;
use OCP\Security\ISecureRandom;
use Throwable;

/**
 * Reads and writes boards: writes one request per board at a time, while reads
 * take no lock unless they move the board on, or answer from the cache of
 * recent changes.
 *
 * Saves merge into the stored board, so a save never removes or lowers what
 * another save stored. A board has an epoch: a restore, or a write by anyone
 * else (WebDAV, the desktop client, a version restore in Files), starts a new
 * one, and saves from an older epoch are refused. Outside writes are found by
 * the events that flag them and by comparing the stored bytes with the digest
 * of the bytes the state was last brought in line with.
 */
class BoardSyncService {
	private const LOCK_WAIT_SECONDS = 10;
	// A reserved write that has not landed after this long belongs to a request that died
	private const PENDING_TIMEOUT_SECONDS = 600;
	// What each recent write changed, so a tab a few saves behind catches up without a read of the file
	private const RECENT_CHANGES_TTL = 600;
	private const RECENT_CHANGES_MAX_REVISIONS = 50;
	private const RECENT_CHANGES_MAX_BYTES = 64 * 1024;

	/** @var array<int,array{digest: string, replaced: \Closure(): bool, checked: bool, outside: bool, unchecked: bool, landed: bool}> boards this PHP request is writing, the digest of the bytes the write replaces, whether someone else wrote the file since, whether the storage wrapper checked the write, found such a write, could not check, and wrote */
	private static array $writing = [];

	private ICache $changeCache;
	// With Nextcloud's file locking on, the board lock keeps every other writer out
	private bool $fileLocking;

	public function __construct(
		private WhiteboardContentService $content,
		private BoardStateStore $states,
		private ILockingProvider $locking,
		private ISecureRandom $random,
		private ITimeFactory $time,
		ICacheFactory $cacheFactory,
		IConfig $config,
		private IEventDispatcher $dispatcher,
	) {
		$this->changeCache = $cacheFactory->createDistributed('whiteboard-changes');
		$this->fileLocking = $config->getSystemValueBool('filelocking.enabled', true);
	}

	/**
	 * @return array{digest: string, replaced: \Closure(): bool, checked: bool, outside: bool, unchecked: bool, landed: bool}
	 */
	private static function ownWrite(int $fileId): array {
		return self::$writing[$fileId];
	}

	/**
	 * Whether this request is writing the board right now
	 */
	public static function isWriting(int $fileId): bool {
		return isset(self::$writing[$fileId]);
	}

	/**
	 * Runs `$write`, the write of `$path` in `$storage`, unless it writes a
	 * board this request saves over bytes that are not those the save
	 * replaces. Whiteboard's storage wrapper calls it on every mount, inside
	 * the exclusive lock Nextcloud takes on the file for the write, so no
	 * other writer lands between the check and the write. A board that both
	 * a share's storage and its owner's storage wrap is checked once.
	 *
	 * @param \Closure(): (int|float|false) $write
	 * @return int|float|false what `$write` returns, or false for a write that does not happen
	 */
	public static function guardOwnWrite(IStorage $storage, string $path, \Closure $write): int|float|false {
		if (self::$writing === []) {
			return $write();
		}
		$fileId = $storage->getCache()->getId($path);
		$own = self::$writing[$fileId] ?? null;
		if ($own === null || $own['checked']) {
			return $write();
		}
		self::$writing[$fileId]['checked'] = true;
		try {
			$bytes = $storage->file_get_contents($path);
			if ($bytes === false) {
				throw new GenericFileException('The board cannot be read');
			}
			// Files' version restore copies its bytes before it updates the file cache, so only the bytes tell.
			// A restore can write back the same bytes; it still starts a new epoch
			$replaced = hash('sha256', $bytes) !== $own['digest'] || ($own['replaced'])();
		} catch (Throwable) {
			self::$writing[$fileId]['unchecked'] = true;
			return false;
		}
		if ($replaced) {
			self::$writing[$fileId]['outside'] = true;
			return false;
		}
		$written = $write();
		self::$writing[$fileId]['landed'] = $written !== false;
		return $written;
	}

	/**
	 * The whole board, or only what changed after revision `$since` when the
	 * client is in the board's epoch and a delta can start from `$since`
	 *
	 * @return array{sync: array{epoch: string, rev: int, restored: bool}, data?: array<string,mixed>, delta?: array<string,mixed>}
	 * @throws BoardUnreadableException the stored bytes are not a board
	 * @throws BoardBusyException another request is changing the board
	 */
	public function read(File $file, ?string $epoch, ?int $since): array {
		if ($epoch !== null && $since !== null) {
			// Storage wrappers such as files_accesscontrol decide on reads, and the recent changes reach no storage
			if (!$file->getStorage()->isReadable($file->getInternalPath())) {
				throw new NotPermittedException();
			}
			$state = $this->states->find($file->getId());
			if ($state !== null && $state->epoch === $epoch && $since <= $state->rev && $state->rev - $since <= self::RECENT_CHANGES_MAX_REVISIONS
				&& $state->pendingDigest === null && !$state->outsideWrite && $state->etag !== null && $state->etag === $file->getEtag()) {
				$delta = $this->recentChanges($state, $since);
				if ($delta !== null) {
					$this->dispatcher->dispatchTyped(new BeforeNodeReadEvent($file));
					return ['sync' => $state->toSync(), 'delta' => $delta];
				}
			}
		}

		// Reads that leave the board as it is wait for no other read, but let a save in progress
		// finish first: its write needs the file, which a read holds. One that has to move the board on does it alone.
		return $this->untilFree(fn (): ?array => $this->locking->isLocked($this->boardKey($file->getId()), ILockingProvider::LOCK_EXCLUSIVE)
			? null
			: ($this->readUnlocked($file, $epoch, $since)
				?? $this->ifLocked($file->getId(), fn (): array => $this->readOpen($file, $epoch, $since, true) ?? throw new LogicException('A board opens under its exclusive lock'))));
	}

	/**
	 * The answer of a read without a lock, or null when the board has to move on or another request changes it meanwhile
	 *
	 * @return array{sync: array{epoch: string, rev: int, restored: bool}, data?: array<string,mixed>, delta?: array<string,mixed>}|null
	 */
	private function readUnlocked(File $file, ?string $epoch, ?int $since): ?array {
		try {
			return $this->readOpen($file, $epoch, $since, false);
		} catch (BoardBusyException|HintException|ServerNotAvailableException) {
			// Nextcloud's encryption cannot read bytes a write is under way on
			return null;
		}
	}

	/**
	 * @return array{sync: array{epoch: string, rev: int, restored: bool}, data?: array<string,mixed>, delta?: array<string,mixed>}|null null when the state has to change and `$mayChange` is false
	 */
	private function readOpen(File $file, ?string $epoch, ?int $since, bool $mayChange): ?array {
		$opened = $this->open($file, $mayChange);
		if ($opened === null) {
			return null;
		}
		[$state, $board] = $opened;
		if ($board === null) {
			throw new BoardUnreadableException($state);
		}
		$delta = $epoch === $state->epoch && $since !== null && $since <= $state->rev ? $this->delta($board, $since, $state->rev) : null;
		return $delta !== null
			? ['sync' => $state->toSync(), 'delta' => $delta]
			: ['sync' => $state->toSync(), 'data' => $this->content->forClient($board)];
	}

	/**
	 * Merges elements, files and board settings into the board and returns
	 * what changed after revision `$since`, or the whole board when the merge
	 * dropped deletions made after it. With `$repair`, a board that cannot be
	 * read is replaced by what the client sends. The answer also lists the
	 * images elements on the board show and the board lacks.
	 *
	 * @param array<mixed> $elements
	 * @param array<mixed> $files
	 * @param array<mixed> $settings
	 * @return array{sync: array{epoch: string, rev: int, restored: bool}, delta?: array<string,mixed>, data?: array<string,mixed>, missingFiles: list<string>}
	 * @throws BoardReplacedException the board started an epoch the client does not know
	 * @throws BoardUnreadableException the stored bytes are not a board, and this is no repair
	 * @throws BoardBehindException no delta can start from `$since`, so the changes may bring back what the board dropped
	 * @throws BoardBusyException another request is changing the board
	 */
	public function save(File $file, string $epoch, int $since, array $elements, array $files, User $actor, bool $repair = false, array $settings = []): array {
		return $this->locked($file->getId(), function () use ($file, $epoch, $since, $elements, $files, $actor, $repair, $settings): ?array {
			// Uploads and restores take the file's exclusive lock: the shared lock keeps them out from the read
			// of the board until right before its write, also where Nextcloud runs no file hooks for that write
			$prepared = $this->sharingFileLock($file, function () use ($file, $epoch, $since, $elements, $files, $actor, $repair, $settings): array {
				[$state, $board] = $this->open($file) ?? throw new LogicException('A board opens under its exclusive lock');
				if ($state->epoch !== $epoch) {
					throw new BoardReplacedException($state);
				}
				if ($board === null && !$repair) {
					throw new BoardUnreadableException($state);
				}
				if ($board !== null && ($since > $state->rev || $this->content->changesSince($board, $since, $state->rev) === null)) {
					throw new BoardBehindException($state);
				}

				// A repair starts from an empty board, so even an empty scene makes the stored bytes readable again
				$merged = $this->content->merge($board ?? $this->content->forClient([]), $elements, $files, $actor, $file->getId(), $state->rev + 1, $settings, $since);
				if ($merged['elements'] === [] && $merged['files'] === [] && $merged['settings'] === [] && $board !== null) {
					return ['state' => $state, 'board' => $board, 'write' => null];
				}
				return ['state' => $state, 'board' => $merged['board'], 'write' => $this->reserve($file, $state, $merged['board'])];
			});

			$state = $prepared['write'] === null
				? $prepared['state']
				: $this->write($file, $prepared['state'], $prepared['write'], $this->delta($prepared['board'], $prepared['state']->rev, $prepared['state']->rev + 1));
			if ($state === null) {
				return null;
			}
			$delta = $this->delta($prepared['board'], $since, $state->rev);
			return ['sync' => $state->toSync()]
				+ ($delta !== null ? ['delta' => $delta] : ['data' => $this->content->forClient($prepared['board'])])
				+ ['missingFiles' => $this->content->missingFiles($prepared['board'])];
		});
	}

	/**
	 * The state of the board, brought in line with the stored bytes, and the
	 * board, or null when the bytes are not a board. Without `$mayChange`
	 * (under a shared lock), null when the state would have to change.
	 *
	 * @return array{0: BoardState, 1: array<string,mixed>|null}|null
	 */
	private function open(File $file, bool $mayChange = true): ?array {
		$before = $this->states->find($file->getId());
		// The ETag from before the bytes: a write landing in between makes it stale, so the next read does not trust it
		$etag = $file->getEtag();
		try {
			$bytes = $mayChange ? $file->getContent() : $this->bytesWithoutLock($file);
		} catch (LockedException) {
			// Someone else writes the file right now
			throw new BoardBusyException();
		}
		$digest = hash('sha256', $bytes);
		try {
			$board = $this->content->decode($bytes);
		} catch (JsonException) {
			$board = null;
			// Without the ETag, reads of these bytes read them again instead of answering from the revision
			$etag = null;
		}
		$latest = $board === null ? 0 : $this->content->latestRevision($board);
		$state = $this->states->find($file->getId());
		if ($state === null && !$mayChange) {
			return null;
		}
		$state ??= $this->states->create($file->getId(), $this->newEpoch(), $latest, $digest, $etag);
		// The checks below need bytes and row of the same moment. A save may move
		// the board on during a read, and an outside write noted meanwhile may
		// have landed after the bytes were read.
		if ($before === null
			? $state->digest !== $digest || $state->outsideWrite
			: [$before->rev, $before->digest, $before->outsideCount] !== [$state->rev, $state->digest, $state->outsideCount]) {
			if ($mayChange || $before === null || $before->pendingDigest !== null || $before->outsideWrite || $digest !== $before->digest) {
				throw new BoardBusyException();
			}
			// A read answers with the state the bytes it read belong to
			$state = $before;
		}

		if (!$mayChange && ($state->pendingDigest !== null || $state->outsideWrite || $digest !== $state->digest)) {
			return null;
		}

		if ($state->pendingDigest !== null) {
			$landed = $digest === $state->pendingDigest;
			if ($landed && $state->pendingDigest !== $state->digest) {
				// The last write landed, but its request ended before recording it
				$state = $this->commitPending($state, $digest, $etag);
			} elseif (!$this->fileLocking && $this->time->getTime() - ($state->pendingAt ?? 0) < self::PENDING_TIMEOUT_SECONDS) {
				// Without file locking another request may still be writing:
				// the bytes may be the old ones, look like them, or be half written
				throw new BoardBusyException();
			} elseif ($landed) {
				$state = $this->commitPending($state, $digest, $etag);
			} else {
				$state = $this->move($state, $state->rev, ['pending_digest' => null, 'pending_at' => null]);
			}
		}

		if ($state->outsideWrite || $digest !== $state->digest) {
			$state = $this->startEpoch($state, $latest, $digest, $etag);
		}

		return [$state, $board];
	}

	/**
	 * The stored bytes without Nextcloud's file lock, for a read that changes
	 * nothing: it trusts them only when their digest is the one the state
	 * notes, so half-written bytes send it to the locked read. Nextcloud's
	 * database locks would keep the lock until the request ends, and with it
	 * the save that waits for the file from writing. The read event Nextcloud's
	 * View would send goes out all the same, for admin_audit.
	 *
	 * @throws NotPermittedException
	 * @throws BoardBusyException
	 */
	private function bytesWithoutLock(File $file): string {
		if (!$file->isReadable()) {
			throw new NotPermittedException();
		}
		$this->dispatcher->dispatchTyped(new BeforeNodeReadEvent($file));
		$bytes = $file->getStorage()->file_get_contents($file->getInternalPath());
		if ($bytes === false) {
			throw new BoardBusyException();
		}
		return $bytes;
	}

	/**
	 * Drops the reservation of a write that did not happen
	 */
	private function release(BoardState $reserved): void {
		$this->states->update($reserved->fileId, $reserved->rev, $reserved->rev, ['pending_digest' => null, 'pending_at' => null]);
	}

	private function commitPending(BoardState $state, string $digest, ?string $etag): BoardState {
		return $this->move($state, $state->rev, [
			'digest' => $digest,
			'etag' => $etag,
			'pending_digest' => null,
			'pending_at' => null,
		]);
	}

	/**
	 * Refuses to write over bytes someone else wrote since the board was read
	 * and reserves the next revision for the bytes of `$board`. The caller
	 * holds the file's shared lock.
	 *
	 * @param array<string,mixed> $board
	 * @return array{reserved: BoardState, bytes: string, digest: string, stamp: ?string}
	 * @throws BoardReplacedException
	 * @throws BoardBusyException
	 */
	private function reserve(File $file, BoardState $state, array $board): array {
		$bytes = $this->content->encode($board);
		$digest = hash('sha256', $bytes);
		$this->refuseOutsideWrite($file, $state);
		return [
			'reserved' => $this->move($state, $state->rev + 1, [
				'pending_digest' => $digest,
				'pending_at' => $this->time->getTime(),
			]),
			'bytes' => $bytes,
			'digest' => $digest,
			// Taken under the shared lock: a write that waits for reads looks at the bytes again only when the file changed since
			'stamp' => $this->fileLocking ? self::stamp($file) : null,
		];
	}

	/**
	 * Writes the reserved bytes and records the write. While reads hold the
	 * file, the write is tried again under the board lock, which keeps new
	 * reads waiting; null, without the reservation, when the file changed
	 * meanwhile, so the save starts over.
	 *
	 * @param BoardState $state the state the reservation was made from
	 * @param array{reserved: BoardState, bytes: string, digest: string, stamp: ?string} $write
	 * @param array<string,mixed>|null $changes what the write changes, kept for tabs that catch up
	 */
	private function write(File $file, BoardState $state, array $write, ?array $changes): ?BoardState {
		$reserved = $write['reserved'];
		$fileId = $file->getId();
		self::$writing[$fileId] = ['digest' => $state->digest, 'replaced' => fn (): bool => $this->states->find($fileId)?->outsideWrite ?? false, 'checked' => false, 'outside' => false, 'unchecked' => false, 'landed' => false];
		$deadline = microtime(true) + (float)self::LOCK_WAIT_SECONDS;
		$delay = 20000;
		try {
			while (true) {
				try {
					$file->putContent($write['bytes']);
					break;
				} catch (GenericFileException $e) {
					// File::putContent() throws when the storage wrapper refuses the write
					$own = self::ownWrite($fileId);
					if (!$own['outside'] && !$own['unchecked']) {
						throw $e;
					}
					break;
				} catch (LockedException) {
					// Nextcloud's database locks keep a read's shared lock until its request ends
					if (microtime(true) >= $deadline) {
						throw new BoardBusyException();
					}
					usleep($delay);
					$delay = min($delay * 2, 250000);
					if (!$this->stillHolds($file, $state, $write['stamp'])) {
						$this->release($reserved);
						return null;
					}
				}
			}
			$own = self::ownWrite($fileId);
			if ($own['unchecked']) {
				throw new BoardBusyException();
			}
			$outside = $own['outside'];
			// Another app's file hook can cancel the write, and then File::putContent() returns as if it wrote
			if (!$outside && !$own['landed'] && hash('sha256', $file->getContent()) !== $write['digest']) {
				throw new NotPermittedException();
			}
		} catch (Throwable $e) {
			$this->release($reserved);
			throw $e;
		} finally {
			unset(self::$writing[$fileId]);
		}
		if ($outside) {
			// The storage wrapper found bytes someone else wrote and refused the write, which no request may wait for
			$this->release($reserved);
			[$seen, $bytes] = $this->sharingFileLock($file, fn (): array => [$this->states->find($fileId), $file->getContent()]);
			throw new BoardReplacedException($this->startEpochWith($reserved, $seen, $bytes));
		}

		$encoded = $changes === null ? false : json_encode($changes);
		if ($encoded !== false && strlen($encoded) <= self::RECENT_CHANGES_MAX_BYTES) {
			$this->changeCache->set($this->recentChangesKey($reserved->fileId, $reserved->epoch, $reserved->rev), $encoded, self::RECENT_CHANGES_TTL);
		}

		return $this->commitPending($reserved, $write['digest'], $file->getEtag());
	}

	/**
	 * Refuses to write over bytes someone else wrote since the board was read
	 * (a WebDAV upload, a version restore in Files): the board starts a new
	 * epoch with them instead. With Nextcloud's file locking, the caller's
	 * shared lock kept other writers out since the board was read, so only a
	 * noted outside write, such as a restore of the same bytes, needs the
	 * bytes. The storage wrapper checks again inside Nextcloud's exclusive lock
	 * of the write.
	 *
	 * @throws BoardReplacedException
	 * @throws BoardBusyException
	 */
	private function refuseOutsideWrite(File $file, BoardState $state): void {
		// Writes are noted after their bytes land, so the bytes hold every write the state read first notes
		$seen = $this->states->find($file->getId());
		$outside = $seen?->outsideWrite ?? false;
		if ($this->fileLocking && !$outside) {
			return;
		}
		$bytes = $file->getContent();
		if ($outside || hash('sha256', $bytes) !== $state->digest) {
			throw new BoardReplacedException($this->startEpochWith($state, $seen, $bytes));
		}
	}

	/**
	 * Whether the file still holds the bytes `$state` was brought in line
	 * with and nobody else's write is noted; true while someone else holds
	 * the file, which is looked at again later
	 */
	private function stillHolds(File $file, BoardState $state, ?string $stamp): bool {
		try {
			return $this->sharingFileLock($file, fn (): bool => !($this->states->find($file->getId())?->outsideWrite ?? false) && self::holds($file, $stamp, $state->digest));
		} catch (BoardBusyException|LockedException) {
			return true;
		}
	}

	/**
	 * Whether the file still holds the bytes of `$digest`: unchanged in the
	 * file cache since `$stamp`, or else by its bytes
	 */
	private static function holds(File $file, ?string $stamp, string $digest): bool {
		return ($stamp !== null && self::stamp($file) === $stamp) || hash('sha256', $file->getContent()) === $digest;
	}

	/**
	 * The file cache's ETag, size and modification time of the file, read
	 * afresh, or null when the cache has no entry for it
	 */
	private static function stamp(File $file): ?string {
		$entry = $file->getStorage()->getCache()->get($file->getInternalPath());
		return $entry === false ? null : $entry->getEtag() . ':' . $entry->getSize() . ':' . $entry->getMTime();
	}

	/**
	 * Runs `$operation` under the file's shared lock, which keeps every other writer out
	 *
	 * @template T
	 * @param callable(): T $operation
	 * @return T
	 * @throws BoardBusyException
	 */
	private function sharingFileLock(File $file, callable $operation): mixed {
		try {
			$file->lock(ILockingProvider::LOCK_SHARED);
		} catch (LockedException) {
			throw new BoardBusyException();
		}
		try {
			return $operation();
		} finally {
			$file->unlock(ILockingProvider::LOCK_SHARED);
		}
	}

	/**
	 * Starts a new epoch with bytes someone else wrote while this request held
	 * `$state`. `$seen` is the state read before the bytes: a write noted since,
	 * which the bytes may lack, makes the compare-and-swap fail.
	 *
	 * @throws BoardBusyException
	 */
	private function startEpochWith(BoardState $state, ?BoardState $seen, string $bytes): BoardState {
		if ($seen === null || $seen->rev !== $state->rev) {
			throw new BoardBusyException();
		}
		try {
			$latest = $this->content->latestRevision($this->content->decode($bytes));
		} catch (JsonException) {
			$latest = 0;
		}
		return $this->startEpoch($seen, $latest, hash('sha256', $bytes), null);
	}

	/**
	 * The board starts a new epoch with bytes someone else wrote, above the revisions in them
	 */
	private function startEpoch(BoardState $from, int $latest, string $digest, ?string $etag): BoardState {
		return $this->states->startEpoch($from, max($from->rev, $latest) + 1, $this->newEpoch(), $digest, $etag)
			?? throw new BoardBusyException();
	}

	/**
	 * @param array{epoch?:string,digest?:string,etag?:?string,pending_digest?:?string,pending_at?:?int,outside_write?:int,restored?:int} $values
	 */
	private function move(BoardState $state, int $rev, array $values): BoardState {
		if (!$this->states->update($state->fileId, $state->rev, $rev, $values)) {
			throw new BoardBusyException();
		}
		// What this change made, even if another request changes the row right after
		return $state->with($rev, $values);
	}

	/**
	 * Runs `$operation` under the board's exclusive lock, waiting for it, and again while it returns null
	 *
	 * @template T
	 * @param callable(): (T|null) $operation
	 * @return T
	 */
	private function locked(int $fileId, callable $operation): mixed {
		return $this->untilFree(fn (): mixed => $this->ifLocked($fileId, $operation));
	}

	/**
	 * Runs `$operation` under the board's exclusive lock, or returns null at once when another request holds it
	 *
	 * @template T
	 * @param callable(): T $operation
	 * @return T|null
	 */
	private function ifLocked(int $fileId, callable $operation): mixed {
		$key = $this->boardKey($fileId);
		try {
			$this->locking->acquireLock($key, ILockingProvider::LOCK_EXCLUSIVE, 'whiteboard board ' . $fileId);
		} catch (LockedException) {
			return null;
		}
		try {
			return $operation();
		} finally {
			$this->locking->releaseLock($key, ILockingProvider::LOCK_EXCLUSIVE);
		}
	}

	private function boardKey(int $fileId): string {
		return 'whiteboard/board/' . $fileId;
	}

	/**
	 * Tries `$attempt` with growing pauses until it returns a value, and gives up as busy after LOCK_WAIT_SECONDS
	 *
	 * @template T
	 * @param callable(): (T|null) $attempt
	 * @return T
	 * @throws BoardBusyException
	 */
	private function untilFree(callable $attempt): mixed {
		$deadline = microtime(true) + (float)self::LOCK_WAIT_SECONDS;
		$delay = 20000;
		while (true) {
			$result = $attempt();
			if ($result !== null) {
				return $result;
			}
			if (microtime(true) >= $deadline) {
				throw new BoardBusyException();
			}
			usleep($delay);
			$delay = min($delay * 2, 250000);
		}
	}

	/**
	 * @param array<string,mixed> $board
	 * @param int $rev the revision of the board
	 * @return array{elements: list<array<string,mixed>>, files: array<string,mixed>|object, settings?: array<string,mixed>}|null null when no delta can start from `$since`
	 */
	private function delta(array $board, int $since, int $rev): ?array {
		$changes = $this->content->changesSince($board, $since, $rev);
		return $changes === null ? null : $this->deltaOf($changes['elements'], $changes['files'], $changes['settings']);
	}

	/**
	 * The delta clients read: images as an object also when there are none, settings only when some changed
	 *
	 * @param list<array<string,mixed>> $elements
	 * @param array<string,mixed> $files
	 * @param array<string,mixed> $settings
	 * @return array{elements: list<array<string,mixed>>, files: array<string,mixed>|object, settings?: array<string,mixed>}
	 */
	private function deltaOf(array $elements, array $files, array $settings): array {
		$delta = ['elements' => $elements, 'files' => $files === [] ? (object)[] : $files];
		return $settings === [] ? $delta : $delta + ['settings' => $settings];
	}

	/**
	 * What changed after revision `$since`, put together from the changes of
	 * each later write, or null when one of them is not cached
	 *
	 * @return array{elements: list<array<string,mixed>>, files: array<string,mixed>|object, settings?: array<string,mixed>}|null
	 */
	private function recentChanges(BoardState $state, int $since): ?array {
		$elements = [];
		$files = [];
		$settings = [];
		for ($rev = $since + 1; $rev <= $state->rev; $rev++) {
			$cached = $this->changeCache->get($this->recentChangesKey($state->fileId, $state->epoch, $rev));
			$changes = is_string($cached) ? json_decode($cached, true) : null;
			if (!is_array($changes)) {
				return null;
			}
			foreach ($changes['elements'] ?? [] as $element) {
				$elements[(string)$element['id']] = $element;
			}
			foreach ($changes['files'] ?? [] as $id => $file) {
				$files[(string)$id] = $file;
			}
			foreach ($changes['settings'] ?? [] as $key => $value) {
				$settings[(string)$key] = $value;
			}
		}
		return $this->deltaOf(array_values($elements), $files, $settings);
	}

	private function recentChangesKey(int $fileId, string $epoch, int $rev): string {
		return $fileId . '/' . $epoch . '/' . $rev;
	}

	private function newEpoch(): string {
		return $this->random->generate(16, ISecureRandom::CHAR_ALPHANUMERIC);
	}
}
