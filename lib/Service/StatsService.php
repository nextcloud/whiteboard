<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use OCP\IDBConnection;

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
}
