<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;
use OCP\Server;
use PHPUnit\Framework\Attributes\Group;
use Test\TestCase;

/**
 * The `whiteboard_sync` rows in the database, which BoardSyncServiceTest keeps in memory
 */
#[Group('DB')]
class BoardStateStoreTest extends TestCase {
	private const FILE_ID = 2147480001;

	private BoardStateStore $store;
	private ?int $cachedFileId = null;

	protected function setUp(): void {
		parent::setUp();
		$this->store = new BoardStateStore(Server::get(IDBConnection::class));
		$this->store->delete(self::FILE_ID);
	}

	protected function tearDown(): void {
		$this->store->delete(self::FILE_ID);
		if ($this->cachedFileId !== null) {
			$this->store->delete($this->cachedFileId);
			$qb = Server::get(IDBConnection::class)->getQueryBuilder();
			$qb->delete('filecache')->where($qb->expr()->eq('fileid', $qb->createNamedParameter($this->cachedFileId, IQueryBuilder::PARAM_INT)))->executeStatement();
		}
		parent::tearDown();
	}

	public function testRowsOfBoardsWhoseFileIsGoneAreDropped(): void {
		// Deleting a folder tells of the folder only, not of the boards in it
		$path = 'files/' . uniqid('whiteboard-', true) . '.whiteboard';
		$qb = Server::get(IDBConnection::class)->getQueryBuilder();
		$qb->insert('filecache')->values([
			'storage' => $qb->createNamedParameter(self::FILE_ID, IQueryBuilder::PARAM_INT),
			'path' => $qb->createNamedParameter($path),
			'path_hash' => $qb->createNamedParameter(md5($path)),
		])->executeStatement();
		$this->cachedFileId = $qb->getLastInsertId();
		$this->store->create($this->cachedFileId, 'e1', 0, 'd1', null);
		$this->store->create(self::FILE_ID, 'e1', 0, 'd1', null);

		$this->store->deleteGone();

		$this->assertNotNull($this->store->find($this->cachedFileId));
		$this->assertNull($this->store->find(self::FILE_ID));
	}

	public function testABoardSeenTwiceKeepsTheFirstRow(): void {
		$this->store->create(self::FILE_ID, 'e1', 0, 'd1', 'etag1');

		$state = $this->store->create(self::FILE_ID, 'e2', 5, 'd2', null);

		$this->assertSame(['e1', 0, 'd1', 'etag1'], [$state->epoch, $state->rev, $state->digest, $state->etag]);
	}

	public function testOnlyOneOfTwoRequestsMovesTheBoardOn(): void {
		$state = $this->store->create(self::FILE_ID, 'e1', 0, 'd1', null);

		$this->assertTrue($this->store->update(self::FILE_ID, $state->rev, 1, ['digest' => 'd2']));
		$this->assertFalse($this->store->update(self::FILE_ID, $state->rev, 1, ['digest' => 'd3']));
		$this->assertSame('d2', $this->store->find(self::FILE_ID)?->digest);
	}

	public function testAWriteNotedAfterARestoreKeepsItARestore(): void {
		$this->store->create(self::FILE_ID, 'e1', 0, 'd1', null);

		$this->store->flagOutsideWrite(self::FILE_ID, true);
		$this->store->flagOutsideWrite(self::FILE_ID);

		$this->assertTrue($this->store->find(self::FILE_ID)?->restoreWrite);
	}

	public function testEveryRestoreNotedCountsAndAWriteAfterOneLeavesIt(): void {
		$this->store->create(self::FILE_ID, 'e1', 3, 'd1', null);

		$this->store->flagOutsideWrite(self::FILE_ID, true);
		$this->store->flagOutsideWrite(self::FILE_ID, true);
		$this->store->flagOutsideWrite(self::FILE_ID);

		$stored = $this->store->find(self::FILE_ID);
		$this->assertSame([3, 3, true], [$stored?->rev, $stored?->outsideCount, $stored?->restoreWrite]);
	}

	public function testANewEpochDoesNotEndASecondRestoreNotedAfterTheBoardWasRead(): void {
		$this->store->create(self::FILE_ID, 'e1', 3, 'd1', null);
		$this->store->flagOutsideWrite(self::FILE_ID, true);
		$from = $this->store->find(self::FILE_ID);
		$this->store->flagOutsideWrite(self::FILE_ID, true);

		$this->assertNull($this->store->startEpoch($from, 4, 'e2', 'd2', null));
	}

	public function testANewEpochAfterARestoreIsMarkedRestoredAndEndsTheNote(): void {
		$this->store->create(self::FILE_ID, 'e1', 3, 'd1', null);
		$this->store->flagOutsideWrite(self::FILE_ID, true);
		$from = $this->store->find(self::FILE_ID);

		$state = $this->store->startEpoch($from, 4, 'e2', 'd2', null);

		$this->assertTrue($state?->restored);
		$stored = $this->store->find(self::FILE_ID);
		$this->assertSame(['e2', 4, 'd2', true, false], [$stored?->epoch, $stored?->rev, $stored?->digest, $stored?->restored, $stored?->outsideWrite]);
	}

	public function testANewEpochDoesNotEndARestoreNotedAfterTheBoardWasRead(): void {
		$this->store->create(self::FILE_ID, 'e1', 3, 'd1', null);
		$from = $this->store->find(self::FILE_ID);
		$this->store->flagOutsideWrite(self::FILE_ID, true);

		$this->assertNull($this->store->startEpoch($from, 4, 'e2', 'd2', null));
		$this->assertTrue($this->store->find(self::FILE_ID)?->restoreWrite);
	}

	public function testANewEpochDoesNotEndASecondWriteNotedAfterTheBoardWasRead(): void {
		$this->store->create(self::FILE_ID, 'e1', 3, 'd1', null);
		$this->store->flagOutsideWrite(self::FILE_ID);
		$from = $this->store->find(self::FILE_ID);
		$this->store->flagOutsideWrite(self::FILE_ID);

		$this->assertNull($this->store->startEpoch($from, 4, 'e2', 'd2', null));
		$this->assertTrue($this->store->find(self::FILE_ID)?->outsideWrite);
	}
}
