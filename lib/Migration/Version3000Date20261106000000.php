<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/**
 * The save state of each board: its epoch, its revision and the digest of the
 * bytes Whiteboard last wrote.
 */
class Version3000Date20261106000000 extends SimpleMigrationStep {
	#[\Override]
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		$schema = $schemaClosure();
		if ($schema->hasTable('whiteboard_sync')) {
			return null;
		}

		$table = $schema->createTable('whiteboard_sync');
		$table->addColumn('file_id', Types::BIGINT, ['notnull' => true, 'unsigned' => true]);
		$table->addColumn('epoch', Types::STRING, ['notnull' => true, 'length' => 32]);
		$table->addColumn('rev', Types::BIGINT, ['notnull' => true, 'unsigned' => true, 'default' => 0]);
		$table->addColumn('digest', Types::STRING, ['notnull' => true, 'length' => 64]);
		$table->addColumn('etag', Types::STRING, ['notnull' => false, 'length' => 64]);
		$table->addColumn('pending_digest', Types::STRING, ['notnull' => false, 'length' => 64]);
		$table->addColumn('pending_at', Types::BIGINT, ['notnull' => false, 'unsigned' => true]);
		// 1: someone else wrote the file, 2: a version restore did
		$table->addColumn('outside_write', Types::SMALLINT, ['notnull' => true, 'default' => 0]);
		// How often an outside write was noted, so a request sees each one, also a second restore
		$table->addColumn('outside_count', Types::BIGINT, ['notnull' => true, 'unsigned' => true, 'default' => 0]);
		// The epoch began with a version restore
		$table->addColumn('restored', Types::SMALLINT, ['notnull' => true, 'default' => 0]);
		$table->setPrimaryKey(['file_id']);

		return $schema;
	}
}
