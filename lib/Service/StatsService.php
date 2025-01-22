<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use OCP\IDBConnection;
use OCP\IUserManager;

final class StatsService {
	public function __construct(
		protected IDBConnection $connection,
        private IUserManager $userManager,
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
        $query = $queryBuilder->select('COUNT(*)')
            ->from('whiteboard_events')
            ->where($queryBuilder->expr()->eq('type', $queryBuilder->createNamedParameter('created')))
            ->executeQuery();
        return (int) $query->fetchOne();
    }

    public function getTotalSize(): int {
        $queryBuilder = $this->connection->getQueryBuilder();

        // Sum size of all latest updated events of each file
        $query = $queryBuilder->select('SUM(size)')
            ->from('whiteboard_events')
            ->where($queryBuilder->expr()->in('id', $queryBuilder->createNamedParameter(
                $queryBuilder->select('MAX(id)')
                    ->from('whiteboard_events')
                    ->groupBy('fileid')
            )))
            ->executeQuery();
        return (int) $query->fetchOne();
    }

    public function getTotalElements(): int {
        $queryBuilder = $this->connection->getQueryBuilder();

        // Sum elements of all latest updated events of each file
        $query = $queryBuilder->select('SUM(elements)')
            ->from('whiteboard_events')
            ->where($queryBuilder->expr()->in('id', $queryBuilder->createNamedParameter(
                $queryBuilder->select('MAX(id)')
                    ->from('whiteboard_events')
                    ->groupBy('fileid')
            )))
            ->executeQuery();
        return (int) $query->fetchOne();
    }

    public function getHighActiveUsersByTimeFrames(array $timeFrames): array {
        $result = [];

        foreach ($timeFrames as $timeFrame) {
            $queryBuilder = $this->connection->getQueryBuilder();
            $query = $queryBuilder->select('total_users')
                ->from('whiteboard_active_users')
                ->where($queryBuilder->expr()->gte('timestamp', $queryBuilder->createNamedParameter($timeFrame['from'])))
                ->andWhere($queryBuilder->expr()->lte('timestamp', $queryBuilder->createNamedParameter($timeFrame['to'])))
                ->orderBy('total_users', 'DESC')
                ->setMaxResults(1)
                ->executeQuery();
            $result[] = [
                'from' => $timeFrame['from'],
                'to' => $timeFrame['to'],
                'total_users' => (int) $query->fetchOne(),
            ];
        }

        return $result;
    }

    public function getStoredBoardsByTimeFrames(array $timeFrames): array {
        $result = [];

        foreach ($timeFrames as $timeFrame) {
            $queryBuilder = $this->connection->getQueryBuilder();
            $query = $queryBuilder->select('COUNT(*)')
                ->from('whiteboard_events')
                ->where($queryBuilder->expr()->eq('type', $queryBuilder->createNamedParameter('created')))
                ->andWhere($queryBuilder->expr()->gte('timestamp', $queryBuilder->createNamedParameter($timeFrame['from'])))
                ->andWhere($queryBuilder->expr()->lte('timestamp', $queryBuilder->createNamedParameter($timeFrame['to'])))
                ->executeQuery();
            $createdCount = $query->fetchOne();

            $queryBuilder = $this->connection->getQueryBuilder();
            $query = $queryBuilder->select('COUNT(*)')
                ->from('whiteboard_events')
                ->where($queryBuilder->expr()->eq('type', $queryBuilder->createNamedParameter('deleted')))
                ->andWhere($queryBuilder->expr()->gte('timestamp', $queryBuilder->createNamedParameter($timeFrame['from'])))
                ->andWhere($queryBuilder->expr()->lte('timestamp', $queryBuilder->createNamedParameter($timeFrame['to'])))
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

    public function getUsersStoredBoards(array $filter, string $orderBy, int $offset = 0, int $limit = 10): array {
        // Get count of boards created by each user. Only count fileid which not have any "deleted" event
        $queryBuilder = $this->connection->getQueryBuilder();
        $query = $queryBuilder->select('user', 'COUNT(DISTINCT fileid) as count')
            ->from('whiteboard_events')
            ->where($queryBuilder->expr()->eq('type', $queryBuilder->createNamedParameter('created')))
            ->andWhere($queryBuilder->expr()->notIn('fileid', $queryBuilder->createNamedParameter(
                $queryBuilder->select('fileid')
                    ->from('whiteboard_events')
                    ->where($queryBuilder->expr()->eq('type', $queryBuilder->createNamedParameter('deleted')))
            )));

        if ($filter['search']) {
            $query = $query->andWhere($queryBuilder->expr()->like('user', $queryBuilder->createNamedParameter('%' . $filter['search'] . '%')));
        }

        return $query->groupBy('user')
            ->orderBy($orderBy)
            ->setMaxResults($limit)
            ->setFirstResult($offset)
            ->executeQuery()
            ->fetchAll();
    }

    public function getBoardsInfo(array $filter, string $orderBy, int $offset = 0, int $limit = 10): array {
        // Get latest boards data by fileid which not have any "deleted" event
        $queryBuilder = $this->connection->getQueryBuilder();
        $query = $queryBuilder->select('fileid', 'user', 'elements', 'size', 'timestamp')
            ->from('whiteboard_events')
            ->where($queryBuilder->expr()->eq('type', $queryBuilder->createNamedParameter('created')))
            ->andWhere($queryBuilder->expr()->notIn('fileid', $queryBuilder->createNamedParameter(
                $queryBuilder->select('fileid')
                    ->from('whiteboard_events')
                    ->where($queryBuilder->expr()->eq('type', $queryBuilder->createNamedParameter('deleted')))
            )));

        if ($filter['search']) {
            $query = $query->andWhere($queryBuilder->expr()->like('user', $queryBuilder->createNamedParameter('%' . $filter['search'] . '%')));
        }

        return $query->orderBy($orderBy)
            ->setMaxResults($limit)
            ->setFirstResult($offset)
            ->executeQuery()
            ->fetchAll();
    }
}
