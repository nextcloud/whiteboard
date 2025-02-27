<?php

namespace OCA\Whiteboard\Tests;

use OCA\Whiteboard\Service\StatsService;
use OCP\IDBConnection;

class StatsServiceTest extends \PHPUnit\Framework\TestCase {
	private IDBConnection $connection;

	public function setUp(): void {
		parent::setUp();

		$this->connection = \OCP\Server::get(IDBConnection::class);
		$this->cleanDb();
	}

	public function cleanDb(): void {
		$this->connection->executeQuery('DELETE from oc_whiteboard_events;');
		$this->connection->executeQuery('DELETE from oc_whiteboard_active_users;');
	}

	public function testInsertEvent(): void {
		$statsService = new StatsService($this->connection);
		$timestamp = time();
		$statsService->insertEvent([
			'user' => 'user1',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 1,
			'elements' => 0,
			'size' => 100,
			'timestamp' => $timestamp,
		]);

		$queryBuilder = $this->connection->getQueryBuilder();
		$query = $queryBuilder->select('*')
			->from('whiteboard_events')
			->executeQuery();
		$insertedRecords = $query->fetchAll();
		$this->assertEquals(1, count($insertedRecords));

		$this->assertEquals('user1', $insertedRecords[0]['user']);
		$this->assertEquals('created', $insertedRecords[0]['type']);
		$this->assertEquals(null, $insertedRecords[0]['share_token']);
		$this->assertEquals(1, $insertedRecords[0]['fileid']);
		$this->assertEquals(0, $insertedRecords[0]['elements']);
		$this->assertEquals(100, $insertedRecords[0]['size']);
		$this->assertEquals($timestamp, $insertedRecords[0]['timestamp']);
	}

	public function testInsertActiveUsersCount(): void {
		$statsService = new StatsService($this->connection);
		$timestamp = time();
		$statsService->insertActiveUsersCount(10);

		$queryBuilder = $this->connection->getQueryBuilder();
		$query = $queryBuilder->select('*')
			->from('whiteboard_active_users')
			->executeQuery();
		$insertedRecords = $query->fetchAll();
		$this->assertEquals(1, count($insertedRecords));

		$this->assertEquals(10, $insertedRecords[0]['total_users']);
		$this->assertEquals($timestamp, $insertedRecords[0]['timestamp']);
	}

	public function testPruneData(): void {
		$statsService = new StatsService($this->connection);
		$timestamp = time();
		$statsService->insertActiveUsersCount(10);
		$statsService->insertEvent([
			'user' => 'user1',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 1,
			'elements' => 0,
			'size' => 100,
			'timestamp' => $timestamp,
		]);

		$statsService->pruneData($timestamp + 1);

		$queryBuilder = $this->connection->getQueryBuilder();
		$query = $queryBuilder->select('*')
			->from('whiteboard_active_users')
			->executeQuery();
		$activeUsersRecords = $query->fetchAll();
		$this->assertEquals(0, count($activeUsersRecords));

		$query = $queryBuilder->select('*')
			->from('whiteboard_events')
			->executeQuery();
		$eventsRecords = $query->fetchAll();
		$this->assertEquals(0, count($eventsRecords));
	}

	public function testGetTotalActiveUsers(): void {
		$statsService = new StatsService($this->connection);
		$statsService->insertActiveUsersCount(10);
		sleep(1);
		$statsService->insertActiveUsersCount(20);

		$totalActiveUsers = $statsService->getTotalActiveUsers();
		$this->assertEquals(20, $totalActiveUsers);
	}

	public function testGetTotalBoards(): void {
		$statsService = new StatsService($this->connection);
		$time = time();
		$statsService->insertEvent([
			'user' => 'user1',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 1,
			'elements' => 0,
			'size' => 100,
			'timestamp' => $time,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 2,
			'elements' => 0,
			'size' => 100,
			'timestamp' => $time + 1,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 3,
			'elements' => 0,
			'size' => 100,
			'timestamp' => $time + 2,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'deleted',
			'share_token' => null,
			'fileid' => 1,
			'elements' => 0,
			'size' => 100,
			'timestamp' => $time + 3,
		]);

		$totalBoards = $statsService->getTotalBoards();
		$this->assertEquals(2, $totalBoards);
	}

	public function testGetTotalSize(): void {
		$statsService = new StatsService($this->connection);
		$time = time();
		$statsService->insertEvent([
			'user' => 'user1',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 1,
			'elements' => 0,
			'size' => 100,
			'timestamp' => $time,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 2,
			'elements' => 0,
			'size' => 200,
			'timestamp' => $time + 1,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 3,
			'elements' => 0,
			'size' => 300,
			'timestamp' => $time + 2,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'deleted',
			'share_token' => null,
			'fileid' => 1,
			'elements' => 0,
			'size' => 100,
			'timestamp' => $time + 3,
		]);

		$totalSize = $statsService->getTotalSize();
		$this->assertEquals(600, $totalSize);
	}

	public function testGetTotalElements(): void {
		$statsService = new StatsService($this->connection);
		$time = time();
		$statsService->insertEvent([
			'user' => 'user1',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 1,
			'elements' => 10,
			'size' => 100,
			'timestamp' => $time,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 2,
			'elements' => 20,
			'size' => 200,
			'timestamp' => $time + 1,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 3,
			'elements' => 30,
			'size' => 300,
			'timestamp' => $time + 2,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'deleted',
			'share_token' => null,
			'fileid' => 1,
			'elements' => 20,
			'size' => 100,
			'timestamp' => $time + 3,
		]);

		$totalElements = $statsService->getTotalElements();
		$this->assertEquals(70, $totalElements);
	}

	public function testGetAverageActiveUsersByTimeFrames(): void {
		$statsService = new StatsService($this->connection);
		$time = time();
		$statsService->insertActiveUsersCount(10);
		sleep(1);
		$statsService->insertActiveUsersCount(20);
		sleep(1);
		$statsService->insertActiveUsersCount(30);
		sleep(1);
		$statsService->insertActiveUsersCount(40);
		sleep(1);
		$statsService->insertActiveUsersCount(50);
		sleep(1);
		$statsService->insertActiveUsersCount(60);
		sleep(1);
		$statsService->insertActiveUsersCount(70);

		$averageActiveUsers = $statsService->getAverageActiveUsersByTimeFrames([
			[
				'from' => $time,
				'to' => $time + 2,
			],
			[
				'from' => $time + 2,
				'to' => $time + 4,
			],
			[
				'from' => $time + 4,
				'to' => $time + 6,
			],
		]);

		$this->assertEquals([
			[
				'from' => $time,
				'to' => $time + 2,
				'value' => 15,
			],
			[
				'from' => $time + 2,
				'to' => $time + 4,
				'value' => 35,
			],
			[
				'from' => $time + 4,
				'to' => $time + 6,
				'value' => 55,
			],
		], $averageActiveUsers);
	}

	public function testGetStoredBoardsByTimeFrames(): void {
		$statsService = new StatsService($this->connection);
		$time = time();
		$statsService->insertEvent([
			'user' => 'user1',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 1,
			'elements' => 0,
			'size' => 100,
			'timestamp' => $time,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 2,
			'elements' => 0,
			'size' => 200,
			'timestamp' => $time + 1,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 3,
			'elements' => 0,
			'size' => 300,
			'timestamp' => $time + 2,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'deleted',
			'share_token' => null,
			'fileid' => 1,
			'elements' => 0,
			'size' => 100,
			'timestamp' => $time + 3,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'deleted',
			'share_token' => null,
			'fileid' => 2,
			'elements' => 0,
			'size' => 200,
			'timestamp' => $time + 4,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'deleted',
			'share_token' => null,
			'fileid' => 3,
			'elements' => 0,
			'size' => 300,
			'timestamp' => $time + 5,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 4,
			'elements' => 0,
			'size' => 400,
			'timestamp' => $time + 6,
		]);

		$storedBoards = $statsService->getStoredBoardsByTimeFrames([
			[
				'from' => $time,
				'to' => $time + 2,
			],
			[
				'from' => $time,
				'to' => $time + 4,
			],
			[
				'from' => $time,
				'to' => $time + 6,
			],
		]);

		$this->assertEquals([
			[
				'from' => $time,
				'to' => $time + 2,
				'value' => 2,
			],
			[
				'from' => $time,
				'to' => $time + 4,
				'value' => 2,
			],
			[
				'from' => $time,
				'to' => $time + 6,
				'value' => 0,
			],
		], $storedBoards);
	}

	public function testGetUsersStoredBoards(): void {
		$statsService = new StatsService($this->connection);
		$time = time();
		$statsService->insertEvent([
			'user' => 'user1',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 1,
			'elements' => 0,
			'size' => 100,
			'timestamp' => $time,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 2,
			'elements' => 0,
			'size' => 200,
			'timestamp' => $time + 1,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 3,
			'elements' => 0,
			'size' => 300,
			'timestamp' => $time + 2,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'deleted',
			'share_token' => null,
			'fileid' => 1,
			'elements' => 0,
			'size' => 100,
			'timestamp' => $time + 3,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'deleted',
			'share_token' => null,
			'fileid' => 2,
			'elements' => 0,
			'size' => 200,
			'timestamp' => $time + 4,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'deleted',
			'share_token' => null,
			'fileid' => 3,
			'elements' => 0,
			'size' => 300,
			'timestamp' => $time + 5,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 4,
			'elements' => 0,
			'size' => 400,
			'timestamp' => $time + 6,
		]);

		$usersStoredBoards = $statsService->getUsersStoredBoards(['search' => 'user'], 'uid', 'ASC', 0, 2);

		$this->assertEquals([
			'totalCount' => 6,
			'items' => [
				[
					'uid' => 'user1',
					'displayname' => null,
					'boards_count' => 0,
				],
				[
					'uid' => 'user2',
					'displayname' => null,
					'boards_count' => 1,
				]
			]
		], $usersStoredBoards);
	}

	public function testGetBoardsInfo(): void {
		$statsService = new StatsService($this->connection);
		$time = time();
		$statsService->insertEvent([
			'user' => 'user1',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 1,
			'elements' => 0,
			'size' => 100,
			'timestamp' => $time,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 2,
			'elements' => 0,
			'size' => 200,
			'timestamp' => $time + 1,
		]);
		$statsService->insertEvent([
			'user' => 'user1',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 3,
			'elements' => 0,
			'size' => 300,
			'timestamp' => $time + 2,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'deleted',
			'share_token' => null,
			'fileid' => 1,
			'elements' => 0,
			'size' => 100,
			'timestamp' => $time + 3,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'deleted',
			'share_token' => null,
			'fileid' => 2,
			'elements' => 0,
			'size' => 200,
			'timestamp' => $time + 4,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 4,
			'elements' => 0,
			'size' => 400,
			'timestamp' => $time + 6,
		]);

		$boardsInfo = $statsService->getBoardsInfo(['search' => 'user'], 'fileid', 'ASC', 0, 3);

		$this->assertEquals([
			'totalCount' => 2,
			'items' => [
				[
					'fileid' => 3,
					'user' => 'user1',
					'elements' => 0,
					'size' => 300,
					'timestamp' => $time + 2
				],
				[
					'fileid' => 4,
					'user' => 'user2',
					'elements' => 0,
					'size' => 400,
					'timestamp' => $time + 6
				]
			]
		], $boardsInfo);
	}

	public function testGetActivities(): void {
		$statsService = new StatsService($this->connection);
		$time = time();
		$statsService->insertEvent([
			'user' => 'user1',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 1,
			'elements' => 0,
			'size' => 100,
			'timestamp' => $time,
		]);
		$statsService->insertEvent([
			'user' => 'user2',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 2,
			'elements' => 0,
			'size' => 200,
			'timestamp' => $time + 1,
		]);
		$statsService->insertEvent([
			'user' => 'user1',
			'type' => 'created',
			'share_token' => null,
			'fileid' => 3,
			'elements' => 0,
			'size' => 300,
			'timestamp' => $time + 2,
		]);

		$activities = $statsService->getActivities(['search' => 'user'], 'timestamp', 'ASC', 0, 3);

		$this->assertEquals([
			'totalCount' => 3,
			'items' => [
				[
					'user' => 'user1',
					'type' => 'created',
					'fileid' => 1,
					'elements' => 0,
					'size' => 100,
					'timestamp' => $time,
				],
				[
					'user' => 'user2',
					'type' => 'created',
					'fileid' => 2,
					'elements' => 0,
					'size' => 200,
					'timestamp' => $time + 1,
				],
				[
					'user' => 'user1',
					'type' => 'created',
					'fileid' => 3,
					'elements' => 0,
					'size' => 300,
					'timestamp' => $time + 2,
				],
			]
		], $activities);
	}
}
