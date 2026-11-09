<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use OCA\Whiteboard\Model\BoardState;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;

/**
 * Rows of `whiteboard_sync`. Every change is a compare-and-swap on `rev`, so
 * two writers can never both move a board on, also without a working lock.
 */
class BoardStateStore {
	private const TABLE = 'whiteboard_sync';

	public function __construct(
		private IDBConnection $db,
	) {
	}

	public function find(int $fileId): ?BoardState {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from(self::TABLE)
			->where($qb->expr()->eq('file_id', $qb->createNamedParameter($fileId, IQueryBuilder::PARAM_INT)));
		$result = $qb->executeQuery();
		$row = $result->fetch();
		$result->closeCursor();
		return $row === false ? null : $this->toState($row);
	}

	/**
	 * The row of a board seen for the first time, or the row another request created meanwhile
	 */
	public function create(int $fileId, string $epoch, int $rev, string $digest, ?string $etag): BoardState {
		$this->db->insertIgnoreConflict(self::TABLE, [
			'file_id' => $fileId,
			'epoch' => $epoch,
			'rev' => $rev,
			'digest' => $digest,
			'etag' => $etag,
			'outside_write' => BoardState::OUTSIDE_NONE,
			'restored' => 0,
		]);
		return $this->find($fileId) ?? throw new \RuntimeException('Could not create the board state');
	}

	/**
	 * Moves the board from `$from` to a new revision; false when another request moved it first,
	 * or when an outside write was noted since `$outsideCount`, when that is given
	 *
	 * @param array{epoch?:string,digest?:string,etag?:?string,pending_digest?:?string,pending_at?:?int,outside_write?:int,restored?:int} $values
	 */
	public function update(int $fileId, int $from, int $rev, array $values, ?int $outsideCount = null): bool {
		$qb = $this->db->getQueryBuilder();
		$qb->update(self::TABLE)
			->set('rev', $qb->createNamedParameter($rev, IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('file_id', $qb->createNamedParameter($fileId, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('rev', $qb->createNamedParameter($from, IQueryBuilder::PARAM_INT)));
		if ($outsideCount !== null) {
			$qb->andWhere($qb->expr()->eq('outside_count', $qb->createNamedParameter($outsideCount, IQueryBuilder::PARAM_INT)));
		}
		foreach ($values as $column => $value) {
			$type = is_int($value) ? IQueryBuilder::PARAM_INT : ($value === null ? IQueryBuilder::PARAM_NULL : IQueryBuilder::PARAM_STR);
			$qb->set($column, $qb->createNamedParameter($value, $type));
		}
		return $qb->executeStatement() === 1;
	}

	/**
	 * Starts a new epoch from `$from` with the bytes of `$digest`: the outside write noted in
	 * `$from` ends, and a version restore marks the new epoch. Null when another request moved
	 * the board, or noted an outside write, since `$from` was read.
	 */
	public function startEpoch(BoardState $from, int $rev, string $epoch, string $digest, ?string $etag): ?BoardState {
		$values = [
			'epoch' => $epoch,
			'digest' => $digest,
			'etag' => $etag,
			'pending_digest' => null,
			'pending_at' => null,
			'outside_write' => BoardState::OUTSIDE_NONE,
			'restored' => $from->restoreWrite ? 1 : 0,
		];
		return $this->update($from->fileId, $from->rev, $rev, $values, $from->outsideCount) ? $from->with($rev, $values) : null;
	}

	/**
	 * Notes that someone else wrote the file; a version restore stays noted as one
	 */
	public function flagOutsideWrite(int $fileId, bool $restore = false): void {
		$qb = $this->db->getQueryBuilder();
		$qb->update(self::TABLE)
			->set('outside_write', $qb->createNamedParameter($restore ? BoardState::OUTSIDE_RESTORE : BoardState::OUTSIDE_WRITE, IQueryBuilder::PARAM_INT))
			->set('outside_count', $qb->func()->add('outside_count', $qb->createNamedParameter(1, IQueryBuilder::PARAM_INT)))
			->where($qb->expr()->eq('file_id', $qb->createNamedParameter($fileId, IQueryBuilder::PARAM_INT)));
		if (!$restore) {
			$qb->andWhere($qb->expr()->eq('outside_write', $qb->createNamedParameter(BoardState::OUTSIDE_NONE, IQueryBuilder::PARAM_INT)));
		}
		$qb->executeStatement();
	}

	public function delete(int $fileId): void {
		$qb = $this->db->getQueryBuilder();
		$qb->delete(self::TABLE)
			->where($qb->expr()->eq('file_id', $qb->createNamedParameter($fileId, IQueryBuilder::PARAM_INT)))
			->executeStatement();
	}

	/**
	 * @param array<string,mixed> $row
	 */
	protected function toState(array $row): BoardState {
		return new BoardState(
			(int)$row['file_id'],
			(string)$row['epoch'],
			(int)$row['rev'],
			(string)$row['digest'],
			$row['etag'] === null ? null : (string)$row['etag'],
			$row['pending_digest'] === null ? null : (string)$row['pending_digest'],
			$row['pending_at'] === null ? null : (int)$row['pending_at'],
			(int)$row['outside_write'] !== BoardState::OUTSIDE_NONE,
			(int)$row['outside_write'] === BoardState::OUTSIDE_RESTORE,
			(int)($row['restored'] ?? 0) === 1,
			(int)($row['outside_count'] ?? 0),
		);
	}
}
