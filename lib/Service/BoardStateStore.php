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
			'outside_write' => 0,
		]);
		return $this->find($fileId) ?? throw new \RuntimeException('Could not create the board state');
	}

	/**
	 * Moves the board from `$from` to a new revision; false when another request moved it first
	 *
	 * @param array{epoch?:string,digest?:string,etag?:?string,pending_digest?:?string,pending_epoch?:?string,pending_at?:?int,outside_write?:int} $values
	 */
	public function update(int $fileId, int $from, int $rev, array $values): bool {
		$qb = $this->db->getQueryBuilder();
		$qb->update(self::TABLE)
			->set('rev', $qb->createNamedParameter($rev, IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('file_id', $qb->createNamedParameter($fileId, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('rev', $qb->createNamedParameter($from, IQueryBuilder::PARAM_INT)));
		foreach ($values as $column => $value) {
			$type = is_int($value) ? IQueryBuilder::PARAM_INT : ($value === null ? IQueryBuilder::PARAM_NULL : IQueryBuilder::PARAM_STR);
			$qb->set($column, $qb->createNamedParameter($value, $type));
		}
		return $qb->executeStatement() === 1;
	}

	/**
	 * Marks that someone else wrote or restored the file; the next request starts a new epoch
	 */
	public function flagOutsideWrite(int $fileId): void {
		$qb = $this->db->getQueryBuilder();
		$qb->update(self::TABLE)
			->set('outside_write', $qb->createNamedParameter(1, IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('file_id', $qb->createNamedParameter($fileId, IQueryBuilder::PARAM_INT)))
			->executeStatement();
	}

	/**
	 * @param array<string,mixed> $row
	 */
	private function toState(array $row): BoardState {
		return new BoardState(
			(int)$row['file_id'],
			(string)$row['epoch'],
			(int)$row['rev'],
			(string)$row['digest'],
			$row['etag'] === null ? null : (string)$row['etag'],
			$row['pending_digest'] === null ? null : (string)$row['pending_digest'],
			$row['pending_epoch'] === null ? null : (string)$row['pending_epoch'],
			$row['pending_at'] === null ? null : (int)$row['pending_at'],
			(int)$row['outside_write'] === 1,
		);
	}
}
