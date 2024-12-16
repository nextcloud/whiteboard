<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use OCP\IDBConnection;

final class EventsService {
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
                'elements' => $queryBuilder->createNamedParameter($data['elements']),
                'size' => $queryBuilder->createNamedParameter($data['size']),
                'timestamp' => $queryBuilder->createNamedParameter($data['timestamp']),
            ])
            ->executeStatement();
    }
}
