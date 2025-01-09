<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

class Version1000Date20241213132620 extends SimpleMigrationStep {

	/**
	 * @param IOutput $output
	 * @param Closure(): ISchemaWrapper $schemaClosure
	 * @param array $options
	 */
	public function preSchemaChange(IOutput $output, Closure $schemaClosure, array $options): void {
	}

	/**
	 * @param IOutput $output
	 * @param Closure(): ISchemaWrapper $schemaClosure
	 * @param array $options
	 * @return null|ISchemaWrapper
	 */
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if (!$schema->hasTable('whiteboard_events')) {
			$table = $schema->createTable('whiteboard_events');
			$table->addColumn('id', Types::BIGINT, [
				'autoincrement' => true,
				'notnull' => true,
				'length' => 20,
			]);
			$table->addColumn('user', Types::STRING, [
				'notnull' => false,
				'length' => 64,
			]);
			$table->addColumn('type', Types::STRING, [
				'notnull' => false,
				'length' => 255,
			]);
			$table->addColumn('share_token', Types::STRING, [
				'notnull' => false,
				'length' => 64,
			]);
			$table->addColumn('fileid', Types::BIGINT, [
				'notnull' => false,
				'length' => 20,
			]);
			$table->addColumn('elements', Types::INTEGER, [
				'notnull' => false,
				'length' => 11,
				'default' => 0,
			]);
			$table->addColumn('size', Types::INTEGER, [
				'notnull' => false,
				'length' => 11,
				'default' => 0,
			]);
			$table->addColumn('timestamp', Types::INTEGER, [
				'notnull' => true,
				'length' => 11,
				'default' => 0,
			]);
			$table->setPrimaryKey(['id']);
			$table->addIndex(['user'], 'whiteboard_user_index');
			$table->addIndex(['fileid'], 'whiteboard_fileid_index');
		}

		if (!$schema->hasTable('whiteboard_active_users')) {
			$table = $schema->createTable('whiteboard_active_users');
			$table->addColumn('id', Types::BIGINT, [
				'autoincrement' => true,
				'notnull' => true,
				'length' => 20,
			]);
			$table->addColumn('total_users', Types::INTEGER, [
				'notnull' => false,
				'length' => 11,
				'default' => 0,
			]);
			$table->addColumn('timestamp', Types::INTEGER, [
				'notnull' => true,
				'length' => 11,
				'default' => 0,
			]);
			$table->setPrimaryKey(['id'], 'whiteboard_active_users_pk');
		}

		return $schema;
	}

	/**
	 * @param IOutput $output
	 * @param Closure(): ISchemaWrapper $schemaClosure
	 * @param array $options
	 */
	public function postSchemaChange(IOutput $output, Closure $schemaClosure, array $options): void {
	}
}
