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

	public function testInsertEvent(): void
	{
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
		$this->assertEquals(1, $query->rowCount());

		$insertedEvent = $query->fetch();
		$this->assertEquals('user1', $insertedEvent['user']);
		$this->assertEquals('created', $insertedEvent['type']);
		$this->assertEquals(null, $insertedEvent['share_token']);
		$this->assertEquals(1, $insertedEvent['fileid']);
		$this->assertEquals(0, $insertedEvent['elements']);
		$this->assertEquals(100, $insertedEvent['size']);
		$this->assertEquals($timestamp, $insertedEvent['timestamp']);
	}

	public function testInsertActiveUsersCount(): void
	{
		$statsService = new StatsService($this->connection);
		$timestamp = time();
		$statsService->insertActiveUsersCount(10);

		$queryBuilder = $this->connection->getQueryBuilder();
		$query = $queryBuilder->select('*')
			->from('whiteboard_active_users')
			->executeQuery();
		$this->assertEquals(1, $query->rowCount());

		$insertedActiveUsers = $query->fetch();
		$this->assertEquals(10, $insertedActiveUsers['total_users']);
		$this->assertEquals($timestamp, $insertedActiveUsers['timestamp']);
	}

	public function testPruneData(): void
	{
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
		$this->assertEquals(0, $query->rowCount());

		$query = $queryBuilder->select('*')
			->from('whiteboard_events')
			->executeQuery();
		$this->assertEquals(0, $query->rowCount());
	}

	public function testGetTotalActiveUsers(): void
	{
		$statsService = new StatsService($this->connection);
		$statsService->insertActiveUsersCount(10);
		sleep(1);
		$statsService->insertActiveUsersCount(20);

		$totalActiveUsers = $statsService->getTotalActiveUsers();
		$this->assertEquals(20, $totalActiveUsers);
	}

	public function testGetTotalBoards(): void
	{
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

	public function testGetTotalSize(): void
	{
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

	public function testGetTotalElements(): void
	{
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

	public function testGetAverageActiveUsersByTimeFrames(): void
	{
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

	public function testGetStoredBoardsByTimeFrames(): void
	{
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
				'created' => 2,
				'deleted' => 0,
				'stored_count' => 2,
			],
			[
				'from' => $time,
				'to' => $time + 4,
				'created' => 3,
				'deleted' => 1,
				'stored_count' => 2,
			],
			[
				'from' => $time,
				'to' => $time + 6,
				'created' => 3,
				'deleted' => 3,
				'stored_count' => 0,
			],
		], $storedBoards);
	}

	public function testGetUsersStoredBoards(): void
	{
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
			[
				'uid' => 'user1',
				'boards_count' => 0,
			],
			[
				'uid' => 'user2',
				'boards_count' => 1,
			]
		], $usersStoredBoards);
	}

	public function testGetBoardsInfo(): void
	{
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
		], $boardsInfo);
	}

    public function testGetActivities(): void
    {
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
        ], $activities);
    }
}