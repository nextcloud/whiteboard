<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;
use OCP\IUserManager;

final class StatsService {
	public function __construct(
		protected IDBConnection $connection,
	) {
	}

	public function insertEvent(array $data): void {
		$queryBuilder = $this->connection->getQueryBuilder();
		$queryBuilder->insert('whiteboard_events')
			->values([
				'user' => $queryBuilder->createNamedParameter($data['user']),
				'type' => $queryBuilder->createNamedParameter($data['type']),
				'share_token' => $queryBuilder->createNamedParameter($data['share_token']),
				'fileid' => $queryBuilder->createNamedParameter($data['fileid']),
				'elements' => $queryBuilder->createNamedParameter($data['elements'] ?? null),
				'size' => $queryBuilder->createNamedParameter($data['size']),
				'timestamp' => $queryBuilder->createNamedParameter($data['timestamp']),
			])
			->executeStatement();
	}

	public function insertActiveUsersCount(int $count): void {
		$queryBuilder = $this->connection->getQueryBuilder();
		$queryBuilder->insert('whiteboard_active_users')
			->values([
				'total_users' => $queryBuilder->createNamedParameter($count),
				'timestamp' => $queryBuilder->createNamedParameter(time()),
			])
			->executeStatement();
	}

	public function pruneData(int $beforeTime): void {
		$queryBuilder = $this->connection->getQueryBuilder();
		$queryBuilder->delete('whiteboard_events')
			->where($queryBuilder->expr()->lt('timestamp', $queryBuilder->createNamedParameter($beforeTime)))
			->executeStatement();

		$queryBuilder = $this->connection->getQueryBuilder();
		$queryBuilder->delete('whiteboard_active_users')
			->where($queryBuilder->expr()->lt('timestamp', $queryBuilder->createNamedParameter($beforeTime)))
			->executeStatement();
	}

	public function getTotalActiveUsers(): int {
		$queryBuilder = $this->connection->getQueryBuilder();
		$query = $queryBuilder->select('total_users')
			->from('whiteboard_active_users')
			->orderBy('timestamp', 'DESC')
			->setMaxResults(1)
			->executeQuery();
		return (int) $query->fetchOne();
	}

	public function getTotalBoards(): int {
		$queryBuilder = $this->connection->getQueryBuilder();
		$query = $queryBuilder->selectAlias($queryBuilder->createFunction('COUNT(id)'), 'count')
			->from('whiteboard_events')
			->where($queryBuilder->expr()->eq('type', $queryBuilder->createNamedParameter('created')))
			->executeQuery();
		$createdBoards = (int) $query->fetchOne();

		$query = $queryBuilder->selectAlias($queryBuilder->createFunction('COUNT(id)'), 'count')
			->from('whiteboard_events')
			->where($queryBuilder->expr()->eq('type', $queryBuilder->createNamedParameter('deleted')))
			->executeQuery();
		$deletedBoards = (int) $query->fetchOne();

		return $createdBoards - $deletedBoards;
	}

	public function getTotalSize(): int {
		$queryBuilder = $this->connection->getQueryBuilder();

		// Sum size of all latest updated events of each file
		$query = $queryBuilder->selectAlias($queryBuilder->createFunction('SUM(size)'), 'total')
			->from('whiteboard_events')
			->where(
				$queryBuilder->expr()->in(
					'id',
					$queryBuilder->createFunction('SELECT MAX(id) FROM oc_whiteboard_events GROUP BY fileid')
				)
			)
			->executeQuery();

		return (int) $query->fetchOne();
	}

	public function getTotalElements(): int {
		$queryBuilder = $this->connection->getQueryBuilder();

		// Sum elements of all latest updated events of each file
		$query = $queryBuilder->selectAlias($queryBuilder->createFunction('SUM(elements)'), 'total')
			->from('whiteboard_events')
			->where(
				$queryBuilder->expr()->in(
					'id',
					$queryBuilder->createFunction('SELECT MAX(id) FROM oc_whiteboard_events GROUP BY fileid')
				)
			)
			->executeQuery();
		return (int) $query->fetchOne();
	}

	public function getAverageActiveUsersByTimeFrames(array $timeFrames): array {
		$result = [];

		foreach ($timeFrames as $timeFrame) {
			$queryBuilder = $this->connection->getQueryBuilder();
			$query = $queryBuilder->selectAlias($queryBuilder->createFunction('AVG(total_users)'), 'average')
				->from('whiteboard_active_users')
				->where($queryBuilder->expr()->gte('timestamp', $queryBuilder->createNamedParameter($timeFrame['from'])))
				->andWhere($queryBuilder->expr()->lt('timestamp', $queryBuilder->createNamedParameter($timeFrame['to'])))
				->executeQuery();
			$result[] = [
				'from' => $timeFrame['from'],
				'to' => $timeFrame['to'],
				'value' => (int) $query->fetchOne(),
			];
		}

		return $result;
	}

	public function getStoredBoardsByTimeFrames(array $timeFrames): array {
		$result = [];

		foreach ($timeFrames as $timeFrame) {
			$queryBuilder = $this->connection->getQueryBuilder();
			$query = $queryBuilder->selectAlias($queryBuilder->createFunction('COUNT(id)'), 'count')
				->from('whiteboard_events')
				->where($queryBuilder->expr()->eq('type', $queryBuilder->createNamedParameter('created')))
				->andWhere($queryBuilder->expr()->gte('timestamp', $queryBuilder->createNamedParameter($timeFrame['from'])))
				->andWhere($queryBuilder->expr()->lt('timestamp', $queryBuilder->createNamedParameter($timeFrame['to'])))
				->executeQuery();
			$createdCount = $query->fetchOne();

			$queryBuilder = $this->connection->getQueryBuilder();
			$query = $queryBuilder->selectAlias($queryBuilder->createFunction('COUNT(id)'), 'count')
				->from('whiteboard_events')
				->where($queryBuilder->expr()->eq('type', $queryBuilder->createNamedParameter('deleted')))
				->andWhere($queryBuilder->expr()->gte('timestamp', $queryBuilder->createNamedParameter($timeFrame['from'])))
				->andWhere($queryBuilder->expr()->lt('timestamp', $queryBuilder->createNamedParameter($timeFrame['to'])))
				->executeQuery();
			$deletedCount = $query->fetchOne();

			$result[] = [
				'from' => $timeFrame['from'],
				'to' => $timeFrame['to'],
				'created' => (int) $createdCount,
				'deleted' => (int) $deletedCount,
				'stored_count' => (int) $createdCount - (int) $deletedCount,
			];
		}

		return $result;
	}

	public function getUsersStoredBoards(array $filter, string $orderBy, string $orderDir = 'ASC', int $offset = 0, int $limit = 10): array {
		// Get count of boards created by each user. Only count fileid which not have any "deleted" event
		$queryBuilder = $this->connection->getQueryBuilder();
		$query = $queryBuilder->select('u.uid')
			->selectAlias(
				$queryBuilder->createFunction('
					(SELECT COUNT(we.fileid)
						FROM oc_whiteboard_events we
						WHERE we.type = "created"
							AND we.fileid NOT IN (SELECT fileid FROM oc_whiteboard_events WHERE type = "deleted") 
							AND we.user = u.uid)'),
				'boards_count'
			)
			->from('users', 'u');

		if (!empty($filter['search'])) {
			$query = $query->andWhere($queryBuilder->expr()->like('u.uid', $queryBuilder->createNamedParameter('%' . $filter['search'] . '%')));
		}

		return $query->orderBy($orderBy, $orderDir)
			->setMaxResults($limit)
			->setFirstResult($offset)
			->executeQuery()
			->fetchAll();
	}

	public function getBoardsInfo(array $filter, string $orderBy, string $orderDir, int $offset = 0, int $limit = 10): array {
		// Get latest boards data by fileid which not have any "deleted" event
		$queryBuilder = $this->connection->getQueryBuilder();
		$query = $queryBuilder->select('fileid', 'user', 'elements', 'size', 'timestamp')
			->from('whiteboard_events')
			->where($queryBuilder->expr()->eq('type', $queryBuilder->createNamedParameter('created')))
			->andWhere($queryBuilder->expr()->notIn(
				'fileid',
				$queryBuilder->createFunction('SELECT fileid FROM oc_whiteboard_events WHERE type = "deleted"')
			));

		if ($filter['search']) {
			$query = $query->andWhere($queryBuilder->expr()->like('user', $queryBuilder->createNamedParameter('%' . $filter['search'] . '%')));
		}

		return $query->orderBy($orderBy, $orderDir)
			->setMaxResults($limit)
			->setFirstResult($offset)
			->executeQuery()
			->fetchAll();
	}

    public function getActivities(array $filter, string $orderBy, string $orderDir, int $offset = 0, int $limit = 10): array {
        $queryBuilder = $this->connection->getQueryBuilder();
        $query = $queryBuilder->select('user', 'type', 'fileid', 'elements', 'size', 'timestamp')
            ->from('whiteboard_events');

        if ($filter['search']) {
            $query = $query->andWhere($queryBuilder->expr()->like('user', $queryBuilder->createNamedParameter('%' . $filter['search'] . '%')));
        }

        return $query->orderBy($orderBy, $orderDir)
            ->setMaxResults($limit)
            ->setFirstResult($offset)
            ->executeQuery()
            ->fetchAll();
    }
}
