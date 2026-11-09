<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use JsonException;
use LogicException;
use OCA\Whiteboard\Exception\BoardBusyException;
use OCA\Whiteboard\Exception\BoardReplacedException;
use OCA\Whiteboard\Exception\BoardUnreadableException;
use OCA\Whiteboard\Model\BoardState;
use OCA\Whiteboard\Model\User;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\Files\File;
use OCP\ICache;
use OCP\ICacheFactory;
use OCP\IConfig;
use OCP\Lock\ILockingProvider;
use OCP\Lock\LockedException;
use OCP\Security\ISecureRandom;
use Throwable;

/**
 * Reads and writes boards: writes one request per board at a time, while reads
 * share the board lock or answer from the cache of recent changes.
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

	/** @var array<int,array{file: File, digest: string, replaced: \Closure(): bool, outside: bool, unchecked?: bool}> boards this PHP request is writing, the digest of the bytes the write replaces, whether someone else wrote the file since, whether the hook found such a write, and whether the check could not run */
	private static array $writing = [];

	private ICache $changeCache;
	// With Nextcloud's file locking on, the board lock keeps every other writer out
	private bool $fileLocking;
	// Reads share the board lock where the locking provider releases a shared lock at once;
	// Nextcloud's database locks keep it until the request ends, so a read could not go on to the exclusive lock
	private bool $sharedReads;

	public function __construct(
		private WhiteboardContentService $content,
		private BoardStateStore $states,
		private ILockingProvider $locking,
		private ISecureRandom $random,
		private ITimeFactory $time,
		ICacheFactory $cacheFactory,
		IConfig $config,
	) {
		$this->changeCache = $cacheFactory->createDistributed('whiteboard-changes');
		$this->fileLocking = $config->getSystemValueBool('filelocking.enabled', true);
		$this->sharedReads = $this->fileLocking && $config->getSystemValueString('memcache.locking', '') !== '';
	}

	/**
	 * @return array{file: File, digest: string, replaced: \Closure(): bool, outside: bool, unchecked?: bool}
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
	 * The `OC_Filesystem` pre-write hook. Nextcloud runs it while it holds a
	 * shared lock on the file, right before it writes, so no other writer can
	 * land between this check and Whiteboard's own write: when the bytes are
	 * not those the write replaces, the write is cancelled. Nextcloud's View
	 * passes `run` as a reference, so setting it to false is what cancels.
	 *
	 * @param array{run?: bool, path?: string} $params
	 * @psalm-suppress PossiblyUnusedMethod called by the hook
	 */
	public static function guardOwnWrite(array $params): void {
		foreach (self::$writing as $fileId => $write) {
			if (basename((string)($params['path'] ?? '')) !== $write['file']->getName()) {
				continue;
			}
			try {
				$bytes = $write['file']->getContent();
				// A restore can write back the same bytes; it still starts a new epoch
				$replaced = hash('sha256', $bytes) !== $write['digest'] || ($write['replaced'])();
			} catch (Throwable) {
				// Nextcloud goes on with the write when a hook throws: without the check it does not happen
				self::$writing[$fileId]['unchecked'] = true;
				$params['run'] = false;
				continue;
			}
			if ($replaced) {
				self::$writing[$fileId]['outside'] = true;
				$params['run'] = false;
			}
		}
	}

	/**
	 * The whole board, or only what changed after revision `$since` when the
	 * client is in the board's epoch
	 *
	 * @return array{sync: array{epoch: string, rev: int, restored: bool}, data?: array<string,mixed>, delta?: array<string,mixed>}
	 * @throws BoardUnreadableException the stored bytes are not a board
	 * @throws BoardBusyException another request is changing the board
	 */
	public function read(File $file, ?string $epoch, ?int $since): array {
		if ($epoch !== null && $since !== null) {
			$state = $this->states->find($file->getId());
			if ($state !== null && $state->epoch === $epoch && $since <= $state->rev && $state->rev - $since <= self::RECENT_CHANGES_MAX_REVISIONS
				&& $state->pendingDigest === null && !$state->outsideWrite && $state->etag !== null && $state->etag === $file->getEtag()) {
				$delta = $this->recentChanges($state, $since);
				if ($delta !== null) {
					return ['sync' => $state->toSync(), 'delta' => $delta];
				}
			}
		}

		// Reads share the board lock; one that has to move the board on does it alone
		return ($this->sharedReads ? $this->locked($file->getId(), ILockingProvider::LOCK_SHARED, fn (): ?array => $this->readOpen($file, $epoch, $since, false)) : null)
			?? $this->locked($file->getId(), ILockingProvider::LOCK_EXCLUSIVE, fn (): ?array => $this->readOpen($file, $epoch, $since, true))
			?? throw new LogicException('A board opens under its exclusive lock');
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
		if ($epoch === $state->epoch && $since !== null && $since <= $state->rev) {
			return ['sync' => $state->toSync(), 'delta' => $this->delta($board, $since)];
		}
		return ['sync' => $state->toSync(), 'data' => $this->content->forClient($board)];
	}

	/**
	 * Merges elements, files and board settings into the board and returns
	 * what changed after revision `$since`. With `$repair`, a board that
	 * cannot be read is replaced by what the client sends.
	 *
	 * @param array<mixed> $elements
	 * @param array<mixed> $files
	 * @param array<mixed> $settings
	 * @return array{sync: array{epoch: string, rev: int, restored: bool}, delta: array<string,mixed>}
	 * @throws BoardReplacedException the board started an epoch the client does not know
	 * @throws BoardUnreadableException the stored bytes are not a board, and this is no repair
	 * @throws BoardBusyException another request is changing the board
	 */
	public function save(File $file, string $epoch, int $since, array $elements, array $files, User $actor, bool $repair = false, array $settings = []): array {
		return $this->locked($file->getId(), ILockingProvider::LOCK_EXCLUSIVE, function () use ($file, $epoch, $since, $elements, $files, $actor, $repair, $settings): array {
			[$state, $board] = $this->open($file) ?? throw new LogicException('A board opens under its exclusive lock');
			if ($state->epoch !== $epoch) {
				throw new BoardReplacedException($state);
			}
			if ($board === null && !$repair) {
				throw new BoardUnreadableException($state);
			}

			// A repair starts from an empty board, so even an empty scene makes the stored bytes readable again
			$merged = $this->content->merge($board ?? $this->content->forClient([]), $elements, $files, $actor, $file->getId(), $state->rev + 1, $settings, $since);
			if ($merged['elements'] === [] && $merged['files'] === [] && $merged['settings'] === [] && $board !== null) {
				return ['sync' => $state->toSync(), 'delta' => $this->delta($board, $since)];
			}

			$state = $this->write($file, $state, $merged['board'], $this->delta($merged['board'], $state->rev));
			return ['sync' => $state->toSync(), 'delta' => $this->delta($merged['board'], $since)];
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
			$bytes = $file->getContent();
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
		// The checks below need bytes and row of the same moment. Another request
		// can only write meanwhile when Nextcloud's file locking is off; an
		// outside write noted meanwhile may have landed after the bytes were read.
		if ($before === null
			? $state->digest !== $digest || $state->outsideWrite
			: [$before->rev, $before->digest, $before->outsideCount] !== [$state->rev, $state->digest, $state->outsideCount]) {
			throw new BoardBusyException();
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
	 * Reserves the next revision, writes the board and records the write
	 *
	 * @param array<string,mixed> $board
	 * @param array<string,mixed> $changes what the write changes, kept for tabs that catch up
	 */
	private function write(File $file, BoardState $state, array $board, array $changes): BoardState {
		$bytes = $this->content->encode($board);
		$digest = hash('sha256', $bytes);
		$this->refuseOutsideWrite($file, $state);
		$reserved = $this->move($state, $state->rev + 1, [
			'pending_digest' => $digest,
			'pending_at' => $this->time->getTime(),
		]);

		$fileId = $file->getId();
		self::$writing[$fileId] = ['file' => $file, 'digest' => $state->digest, 'replaced' => fn (): bool => $this->states->find($fileId)?->outsideWrite ?? false, 'outside' => false];
		try {
			// When the pre-write hook cancels the write, Nextcloud's View returns null and File::putContent() returns normally (it throws only on false)
			$file->putContent($bytes);
			// The pre-write hook may have changed the entry during the write
			$write = self::ownWrite($fileId);
			if ($write['unchecked'] ?? false) {
				throw new BoardBusyException();
			}
			$outside = $write['outside'];
		} catch (Throwable $e) {
			$this->release($reserved);
			throw $e instanceof LockedException ? new BoardBusyException() : $e;
		} finally {
			unset(self::$writing[$fileId]);
		}
		if ($outside) {
			// The pre-write hook found bytes someone else wrote and cancelled the write, which no request may wait for
			$this->release($reserved);
			[$seen, $bytes] = $this->rowAndBytes($file);
			throw new BoardReplacedException($this->startEpochWith($reserved, $seen, $bytes));
		}

		$encoded = json_encode($changes);
		if ($encoded !== false && strlen($encoded) <= self::RECENT_CHANGES_MAX_BYTES) {
			$this->changeCache->set($this->recentChangesKey($reserved->fileId, $reserved->epoch, $reserved->rev), $encoded, self::RECENT_CHANGES_TTL);
		}

		return $this->commitPending($reserved, $digest, $file->getEtag());
	}

	/**
	 * Refuses to write over bytes someone else wrote since the board was read
	 * (a WebDAV upload, a version restore in Files): the board starts a new
	 * epoch with them instead. The check runs under a shared lock on the file;
	 * the pre-write hook checks again inside Nextcloud's own lock of the write
	 * wherever Nextcloud emits its file hooks.
	 *
	 * @throws BoardReplacedException
	 * @throws BoardBusyException
	 */
	private function refuseOutsideWrite(File $file, BoardState $state): void {
		[$seen, $bytes] = $this->rowAndBytes($file);
		if (hash('sha256', $bytes) !== $state->digest || ($seen?->outsideWrite ?? false)) {
			throw new BoardReplacedException($this->startEpochWith($state, $seen, $bytes));
		}
	}

	/**
	 * The state of the board, then the bytes, under a shared lock. Writes are
	 * noted after their bytes land, so the bytes hold every write the state notes.
	 *
	 * @return array{0: ?BoardState, 1: string}
	 * @throws BoardBusyException
	 */
	private function rowAndBytes(File $file): array {
		$seen = $this->states->find($file->getId());
		try {
			$file->lock(ILockingProvider::LOCK_SHARED);
		} catch (LockedException) {
			throw new BoardBusyException();
		}
		try {
			return [$seen, $file->getContent()];
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
	 * @template T
	 * @param ILockingProvider::LOCK_SHARED|ILockingProvider::LOCK_EXCLUSIVE $type
	 * @param callable(): T $operation
	 * @return T
	 */
	private function locked(int $fileId, int $type, callable $operation): mixed {
		$key = 'whiteboard/board/' . $fileId;
		$deadline = microtime(true) + (float)self::LOCK_WAIT_SECONDS;
		$delay = 20000;
		while (true) {
			try {
				$this->locking->acquireLock($key, $type, 'whiteboard board ' . $fileId);
				break;
			} catch (LockedException) {
				if (microtime(true) >= $deadline) {
					throw new BoardBusyException();
				}
				usleep($delay);
				$delay = min($delay * 2, 250000);
			}
		}

		try {
			return $operation();
		} finally {
			$this->locking->releaseLock($key, $type);
		}
	}

	/**
	 * @param array<string,mixed> $board
	 * @return array{elements: list<array<string,mixed>>, files: array<string,mixed>|object, settings?: array<string,mixed>}
	 */
	private function delta(array $board, int $since): array {
		$changes = $this->content->changesSince($board, $since);
		return $this->deltaOf($changes['elements'], $changes['files'], $changes['settings']);
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
