<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use JsonException;
use OCA\Whiteboard\Exception\BoardBusyException;
use OCA\Whiteboard\Exception\BoardReplacedException;
use OCA\Whiteboard\Exception\BoardUnreadableException;
use OCA\Whiteboard\Model\BoardState;
use OCA\Whiteboard\Model\User;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\Files\File;
use OCP\ICache;
use OCP\ICacheFactory;
use OCP\Lock\ILockingProvider;
use OCP\Lock\LockedException;
use OCP\Security\ISecureRandom;
use Throwable;

/**
 * Reads and writes boards, one request per board at a time.
 *
 * Saves merge into the stored board, so a save never removes or lowers what
 * another save stored. A board has an epoch: a restore, or a write by anyone
 * else (WebDAV, the desktop client, a version restore in Files), starts a new
 * one, and saves from an older epoch are refused. Outside writes are found by
 * the events that flag them and by comparing the stored bytes with the digest
 * of Whiteboard's last write.
 */
class BoardSyncService {
	private const LOCK_WAIT_SECONDS = 10;
	// A reserved write that has not landed after this long belongs to a request that died
	private const PENDING_TIMEOUT_SECONDS = 600;
	// What each recent write changed, so a tab a few saves behind catches up without a read of the file
	private const RECENT_CHANGES_TTL = 600;
	private const RECENT_CHANGES_MAX_REVISIONS = 50;
	private const RECENT_CHANGES_MAX_BYTES = 64 * 1024;

	/** @var array<int,true> boards this PHP request is writing */
	private static array $writing = [];

	private ICache $recentChanges;

	public function __construct(
		private WhiteboardContentService $content,
		private BoardStateStore $states,
		private ILockingProvider $locking,
		private ISecureRandom $random,
		private ITimeFactory $time,
		ICacheFactory $cacheFactory,
	) {
		$this->recentChanges = $cacheFactory->createDistributed('whiteboard-changes');
	}

	/**
	 * Whether this request is writing the board right now
	 */
	public function isWriting(int $fileId): bool {
		return isset(self::$writing[$fileId]);
	}

	/**
	 * The whole board, or only what changed after revision `$since` when the
	 * client is in the board's epoch
	 *
	 * @return array{sync: array{epoch: string, rev: int}, data?: array<string,mixed>, delta?: array<string,mixed>}
	 */
	public function read(File $file, ?string $epoch, ?int $since): array {
		if ($epoch !== null && $since !== null) {
			$state = $this->states->find($file->getId());
			if ($state !== null && $state->epoch === $epoch && $since <= $state->rev && $state->rev - $since <= self::RECENT_CHANGES_MAX_REVISIONS
				&& $state->pendingDigest === null && !$state->outsideWrite && $state->etag !== null && $state->etag === $file->getEtag()) {
				$delta = $this->recentChanges($state, $since);
				if ($delta !== null) {
					return ['sync' => $this->sync($state), 'delta' => $delta];
				}
			}
		}

		return $this->locked($file->getId(), function () use ($file, $epoch, $since): array {
			[$state, $board] = $this->open($file);
			if ($board === null) {
				throw new BoardUnreadableException($state);
			}
			if ($epoch === $state->epoch && $since !== null && $since <= $state->rev) {
				return ['sync' => $this->sync($state), 'delta' => $this->delta($board, $since)];
			}
			return ['sync' => $this->sync($state), 'data' => $this->content->forClient($board)];
		});
	}

	/**
	 * Merges elements and files into the board and returns what changed after
	 * revision `$since`. With `$repair`, a board that cannot be read is
	 * replaced by what the client sends.
	 *
	 * @param array<mixed> $elements
	 * @param array<mixed> $files
	 * @return array{sync: array{epoch: string, rev: int}, delta: array<string,mixed>}
	 */
	public function save(File $file, string $epoch, int $since, array $elements, array $files, User $actor, bool $repair = false): array {
		return $this->locked($file->getId(), function () use ($file, $epoch, $since, $elements, $files, $actor, $repair): array {
			[$state, $board] = $this->open($file);
			if ($state->epoch !== $epoch) {
				throw new BoardReplacedException($state);
			}
			if ($board === null && !$repair) {
				throw new BoardUnreadableException($state);
			}

			// A repair starts from an empty board, so even an empty scene makes the stored bytes readable again
			$merged = $this->content->merge($board ?? $this->content->forClient([]), $elements, $files, $actor, $file->getId(), $state->rev + 1);
			if ($merged['elements'] === [] && $merged['files'] === [] && $board !== null) {
				return ['sync' => $this->sync($state), 'delta' => $this->delta($board, $since)];
			}

			$state = $this->write($file, $state, $merged['board'], null, $this->delta($merged['board'], $state->rev));
			return ['sync' => $this->sync($state), 'delta' => $this->delta($merged['board'], $since)];
		});
	}

	/**
	 * Writes a whole board, such as a restored version, and starts a new epoch
	 *
	 * @param array<string,mixed> $board
	 * @return array{sync: array{epoch: string, rev: int}}
	 */
	public function replace(File $file, array $board): array {
		return $this->locked($file->getId(), function () use ($file, $board): array {
			[$state, $current] = $this->open($file);
			$replacement = $this->content->replace($current ?? [], $board, $state->rev + 1);
			return ['sync' => $this->sync($this->write($file, $state, $replacement, $this->newEpoch(), null))];
		});
	}

	/**
	 * The state of the board, brought in line with the stored bytes, and the
	 * board, or null when the bytes are not a board
	 *
	 * @return array{0: BoardState, 1: array<string,mixed>|null}
	 */
	private function open(File $file): array {
		$before = $this->states->find($file->getId());
		// The ETag from before the bytes: a write landing in between makes it stale, so the next read does not trust it
		$etag = $file->getEtag();
		$bytes = $file->getContent();
		$digest = hash('sha256', $bytes);
		try {
			$board = $this->content->decode($bytes);
		} catch (JsonException) {
			$board = null;
		}
		$latest = $board === null ? 0 : $this->content->latestRevision($board);
		$state = $this->states->find($file->getId())
			?? $this->states->create($file->getId(), $this->newEpoch(), $latest, $digest, $etag);
		// The checks below need bytes and row of the same moment. Another request
		// can only write meanwhile when Nextcloud's file locking is off.
		if ($before === null ? $state->digest !== $digest : ($before->rev !== $state->rev || $before->digest !== $state->digest)) {
			throw new BoardBusyException();
		}

		if ($state->pendingDigest !== null) {
			$landed = $digest === $state->pendingDigest;
			if ($landed && $state->pendingDigest !== $state->digest) {
				// The last write landed, but its request ended before recording it
				$state = $this->commitPending($state, $digest, $etag);
			} elseif ($this->time->getTime() - ($state->pendingAt ?? 0) < self::PENDING_TIMEOUT_SECONDS) {
				// Another request may still be writing (only when Nextcloud's file locking is off):
				// the bytes may be the old ones, look like them, or be half written
				throw new BoardBusyException();
			} elseif ($landed) {
				$state = $this->commitPending($state, $digest, $etag);
			} else {
				$state = $this->move($state, $state->rev, ['pending_digest' => null, 'pending_epoch' => null, 'pending_at' => null]);
			}
		}

		if ($state->outsideWrite || $digest !== $state->digest) {
			$state = $this->move($state, max($state->rev, $latest) + 1, [
				'epoch' => $this->newEpoch(),
				'digest' => $digest,
				'etag' => $etag,
				'pending_digest' => null,
				'pending_epoch' => null,
				'pending_at' => null,
				'outside_write' => 0,
			]);
		}

		return [$state, $board];
	}

	private function commitPending(BoardState $state, string $digest, ?string $etag): BoardState {
		return $this->move($state, $state->rev, [
			'epoch' => $state->pendingEpoch ?? $state->epoch,
			'digest' => $digest,
			'etag' => $etag,
			'pending_digest' => null,
			'pending_epoch' => null,
			'pending_at' => null,
		]);
	}

	/**
	 * Reserves the next revision, writes the board and records the write
	 *
	 * @param array<string,mixed> $board
	 * @param array<string,mixed>|null $changes what the write changes, kept for tabs that catch up
	 */
	private function write(File $file, BoardState $state, array $board, ?string $epoch, ?array $changes): BoardState {
		$bytes = $this->content->encode($board);
		$digest = hash('sha256', $bytes);
		$reserved = $this->move($state, $state->rev + 1, [
			'pending_digest' => $digest,
			'pending_epoch' => $epoch,
			'pending_at' => $this->time->getTime(),
		]);

		self::$writing[$file->getId()] = true;
		try {
			$file->putContent($bytes);
		} catch (Throwable $e) {
			$this->states->update($file->getId(), $reserved->rev, $reserved->rev, ['pending_digest' => null, 'pending_epoch' => null, 'pending_at' => null]);
			throw $e instanceof LockedException ? new BoardBusyException() : $e;
		} finally {
			unset(self::$writing[$file->getId()]);
		}

		$encoded = $changes === null ? false : json_encode($changes);
		if ($encoded !== false && strlen($encoded) <= self::RECENT_CHANGES_MAX_BYTES) {
			$this->recentChanges->set($this->recentChangesKey($reserved->fileId, $reserved->epoch, $reserved->rev), $encoded, self::RECENT_CHANGES_TTL);
		}

		return $this->move($reserved, $reserved->rev, [
			'epoch' => $epoch ?? $reserved->epoch,
			'digest' => $digest,
			'etag' => $file->getEtag(),
			'pending_digest' => null,
			'pending_epoch' => null,
			'pending_at' => null,
		]);
	}

	/**
	 * @param array{epoch?:string,digest?:string,etag?:?string,pending_digest?:?string,pending_epoch?:?string,pending_at?:?int,outside_write?:int} $values
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
	 * @param callable(): T $operation
	 * @return T
	 */
	private function locked(int $fileId, callable $operation): mixed {
		$key = 'whiteboard/board/' . $fileId;
		$deadline = microtime(true) + (float)self::LOCK_WAIT_SECONDS;
		$delay = 20000;
		while (true) {
			try {
				$this->locking->acquireLock($key, ILockingProvider::LOCK_EXCLUSIVE, 'whiteboard board ' . $fileId);
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
			$this->locking->releaseLock($key, ILockingProvider::LOCK_EXCLUSIVE);
		}
	}

	/**
	 * @param array<string,mixed> $board
	 * @return array{elements: list<array<string,mixed>>, files: array<string,mixed>|object}
	 */
	private function delta(array $board, int $since): array {
		$changes = $this->content->changesSince($board, $since);
		return ['elements' => $changes['elements'], 'files' => $changes['files'] === [] ? (object)[] : $changes['files']];
	}

	/**
	 * What changed after revision `$since`, put together from the changes of
	 * each later write, or null when one of them is not cached
	 *
	 * @return array{elements: list<array<string,mixed>>, files: array<string,mixed>|object}|null
	 */
	private function recentChanges(BoardState $state, int $since): ?array {
		$elements = [];
		$files = [];
		for ($rev = $since + 1; $rev <= $state->rev; $rev++) {
			$cached = $this->recentChanges->get($this->recentChangesKey($state->fileId, $state->epoch, $rev));
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
		}
		return ['elements' => array_values($elements), 'files' => $files === [] ? (object)[] : $files];
	}

	private function recentChangesKey(int $fileId, string $epoch, int $rev): string {
		return $fileId . '/' . $epoch . '/' . $rev;
	}

	/**
	 * @return array{epoch: string, rev: int}
	 */
	private function sync(BoardState $state): array {
		return ['epoch' => $state->epoch, 'rev' => $state->rev];
	}

	private function newEpoch(): string {
		return $this->random->generate(16, ISecureRandom::CHAR_ALPHANUMERIC);
	}
}
