<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use OCA\Whiteboard\Model\PublicSharingUser;
use OCA\Whiteboard\Model\User;
use OCP\AppFramework\Services\IAppConfig;
use OCP\Files\File;
use OCP\IConfig;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\MockObject\MockObject;
use Test\TestCase;

class WhiteboardContentServiceTest extends TestCase {
	private const CREATOR_PROOF = 'v1:31a3f15ad65d53e0b630d98a4fb2fbb9d629c4cb36992ba211c04f69304665bf';
	private const SECRET = 'test-secret';

	public function testSaveMergesElementsAndKeepsTheRestOfTheBoard(): void {
		$board = $this->save([
			'elements' => [['id' => 'old-element', 'type' => 'rectangle', 'version' => 1, 'versionNonce' => 1]],
			'files' => [],
			'libraryItems' => [['id' => 'library-item-1', 'elements' => [['id' => 'library-element-1', 'type' => 'ellipse']]]],
			'libraryRef' => ['scope' => 'personal', 'name' => 'Kit'],
			'scrollToContent' => true,
		], [
			'elements' => [['id' => 'new-element', 'type' => 'diamond', 'version' => 1, 'versionNonce' => 1]],
			'files' => [],
		]);

		$this->assertSame(['old-element', 'new-element'], array_column($board['elements'], 'id'));
		$this->assertSame('library-item-1', $board['libraryItems'][0]['id']);
		$this->assertSame(['scope' => 'personal', 'name' => 'Kit'], $board['libraryRef']);
	}

	public function testSaveNeverRemovesOrLowersAStoredElement(): void {
		$board = $this->save([
			'elements' => [
				['id' => 'a', 'type' => 'rectangle', 'version' => 5, 'versionNonce' => 9, 'width' => 50],
				['id' => 'b', 'type' => 'rectangle', 'version' => 2, 'versionNonce' => 2],
			],
		], [
			'elements' => [
				['id' => 'a', 'type' => 'rectangle', 'version' => 3, 'versionNonce' => 1, 'width' => 30],
				['id' => 'c', 'type' => 'rectangle', 'version' => 1, 'versionNonce' => 1],
			],
		]);

		$this->assertSame(['a', 'b', 'c'], array_column($board['elements'], 'id'));
		$this->assertSame(50, $board['elements'][0]['width']);
	}

	public function testEqualVersionsKeepTheLowerNonce(): void {
		$stored = ['elements' => [['id' => 'a', 'type' => 'rectangle', 'version' => 4, 'versionNonce' => 20, 'width' => 1]]];

		$lower = $this->save($stored, ['elements' => [['id' => 'a', 'type' => 'rectangle', 'version' => 4, 'versionNonce' => 10, 'width' => 2]]]);
		$higher = $this->save($stored, ['elements' => [['id' => 'a', 'type' => 'rectangle', 'version' => 4, 'versionNonce' => 30, 'width' => 3]]]);

		$this->assertSame(2, $lower['elements'][0]['width']);
		$this->assertNull($higher);
	}

	public function testDeletedElementStaysDeletedAgainstAnOlderCopy(): void {
		$board = $this->save([
			'elements' => [['id' => 'a', 'type' => 'rectangle', 'version' => 6, 'versionNonce' => 1, 'isDeleted' => true]],
		], [
			'elements' => [['id' => 'a', 'type' => 'rectangle', 'version' => 5, 'versionNonce' => 1, 'isDeleted' => false]],
		]);

		$this->assertNull($board);
	}

	public function testFilesAreAddedAndNeverReplaced(): void {
		$board = $this->save([
			'elements' => [],
			'files' => ['one' => ['id' => 'one', 'dataURL' => 'data:stored']],
		], [
			'elements' => [],
			'files' => [
				'one' => ['id' => 'one', 'dataURL' => 'data:other'],
				'two' => ['id' => 'two', 'dataURL' => 'data:new'],
			],
		]);

		$this->assertSame('data:stored', $board['files']['one']['dataURL']);
		$this->assertSame('data:new', $board['files']['two']['dataURL']);
	}

	public function testChangedElementsAndFilesGetTheRevision(): void {
		$result = $this->service()->merge([
			'elements' => [['id' => 'a', 'type' => 'rectangle', 'version' => 1, 'versionNonce' => 1]],
			'revisions' => ['elements' => ['a' => 3], 'files' => []],
		], [
			['id' => 'b', 'type' => 'rectangle', 'version' => 1, 'versionNonce' => 1],
		], ['f' => ['id' => 'f', 'dataURL' => 'data:x']], $this->actor(), 123, 4);

		$this->assertSame(['a' => 3, 'b' => 4], $result['board']['revisions']['elements']);
		$this->assertSame(['f' => 4], $result['board']['revisions']['files']);
		$this->assertSame(['b'], $result['elements']);
		$this->assertSame(['f'], $result['files']);
		$changes = $this->service()->changesSince($result['board'], 3);
		$this->assertSame(['b'], array_column($changes['elements'], 'id'));
		$this->assertSame(['f'], array_keys($changes['files']));
	}

	public function testElementsAreOrderedByFractionalIndex(): void {
		$board = $this->save([
			'elements' => [
				['id' => 'a', 'type' => 'rectangle', 'version' => 1, 'versionNonce' => 1, 'index' => 'a0'],
				['id' => 'b', 'type' => 'rectangle', 'version' => 1, 'versionNonce' => 1, 'index' => 'a1'],
			],
		], [
			'elements' => [['id' => 'a', 'type' => 'rectangle', 'version' => 2, 'versionNonce' => 1, 'index' => 'a2']],
		]);

		$this->assertSame(['b', 'a'], array_column($board['elements'], 'id'));
	}

	public function testBoardsWithoutIndicesKeepTheirOrder(): void {
		$board = $this->save([
			'elements' => [
				['id' => 'b', 'type' => 'rectangle', 'version' => 1, 'versionNonce' => 1],
				['id' => 'a', 'type' => 'rectangle', 'version' => 1, 'versionNonce' => 1],
			],
		], [
			'elements' => [['id' => 'c', 'type' => 'rectangle', 'version' => 1, 'versionNonce' => 1, 'index' => 'a0']],
		]);

		$this->assertSame(['b', 'a', 'c'], array_column($board['elements'], 'id'));
	}

	public function testRestoreReplacesTheBoardAndKeepsItsLibrary(): void {
		$board = $this->service()->replace([
			'elements' => [['id' => 'now', 'type' => 'rectangle', 'version' => 9, 'versionNonce' => 1]],
			'libraryRef' => ['scope' => 'personal', 'name' => 'Kit'],
		], [
			'elements' => [['id' => 'then', 'type' => 'rectangle', 'version' => 2, 'versionNonce' => 1]],
			'files' => ['f' => ['id' => 'f', 'dataURL' => 'data:x']],
			'appState' => ['viewBackgroundColor' => '#000000'],
		], 7);

		$this->assertSame(['then'], array_column($board['elements'], 'id'));
		$this->assertSame(['scope' => 'personal', 'name' => 'Kit'], $board['libraryRef']);
		$this->assertSame(['then' => 7], $board['revisions']['elements']);
		$this->assertSame(['f' => 7], $board['revisions']['files']);
		$this->assertArrayNotHasKey('revisions', $this->service()->forClient($board));
	}

	public function testClientsAlwaysReadAnElementList(): void {
		foreach ([[], ['data' => ['elements' => [['id' => 'a', 'type' => 'rectangle', 'version' => 1, 'versionNonce' => 1]]]]] as $stored) {
			$board = $this->service()->forClient($stored);
			$this->assertIsArray($board['elements']);
		}
		$this->assertSame(['a'], array_column($board['elements'], 'id'));
	}

	public function testTheWinningCopyCountsWhenARequestCarriesAnElementTwice(): void {
		$stored = ['elements' => [['id' => 'a', 'type' => 'rectangle', 'version' => 1, 'versionNonce' => 1]]];
		$board = $this->service()->merge($stored, [
			['id' => 'a', 'type' => 'rectangle', 'version' => 2, 'versionNonce' => 1],
			['id' => 'a', 'type' => 'rectangle', 'version' => 3, 'versionNonce' => 1],
		], [], $this->actor(), 42, 2)['board'];

		$this->assertSame(3, $board['elements'][0]['version']);
	}

	public function testSaveWithUnchangedElementVersionsWritesNothing(): void {
		$file = $this->mockFileWithContent([
			'elements' => [[
				'id' => 'arrow',
				'type' => 'arrow',
				'version' => 7,
				'versionNonce' => 42,
				'startBinding' => ['elementId' => 'box', 'focus' => 0.1, 'gap' => 4],
			]],
			'files' => [],
			'scrollToContent' => true,
		]);
		$file->expects($this->never())->method('putContent');

		$this->updateContent($file, [
			'data' => [
				'elements' => [[
					'id' => 'arrow',
					'type' => 'arrow',
					'version' => 7,
					'versionNonce' => 42,
					'startBinding' => ['elementId' => 'box', 'fixedPoint' => [0.5, 1], 'mode' => 'orbit'],
				]],
				'files' => [],
				'scrollToContent' => true,
			],
		], $this->actor());
	}

	public function testSaveWithChangedElementVersionWrites(): void {
		$file = $this->mockFileWithContent([
			'elements' => [['id' => 'box', 'type' => 'rectangle', 'version' => 7, 'versionNonce' => 42, 'width' => 10]],
			'files' => [],
			'scrollToContent' => true,
		]);
		$captured = $this->captureWrite($file);

		$this->updateContent($file, [
			'data' => [
				'elements' => [['id' => 'box', 'type' => 'rectangle', 'version' => 8, 'versionNonce' => 43, 'width' => 20]],
				'files' => [],
				'scrollToContent' => true,
			],
		], $this->actor());

		$this->assertSame(20, $captured->data['elements'][0]['width']);
	}

	public function testDirectSaveCanonicalizesForgedCreatorToActor(): void {
		$file = $this->mockEmptyFile();
		$captured = $this->captureWrite($file);

		$this->updateContent($file, [
			'data' => [
				'elements' => [[
					'id' => 'forged-element',
					'type' => 'text',
					'text' => 'We should rewrite Nextcloud in Rust',
					'customData' => [
						'creator' => ['uid' => 'bob', 'displayName' => 'Bob', 'createdAt' => 1],
						'creatorProof' => 'v1:' . str_repeat('0', 64),
					],
				]],
			],
		], $this->actor('admin', 'Admin'));

		$creator = $captured->data['elements'][0]['customData']['creator'];
		$this->assertSame('admin', $creator['uid']);
		$this->assertSame('Admin', $creator['displayName']);
		$this->assertMatchesRegularExpression('/^v1:[a-f0-9]{64}$/', $captured->data['elements'][0]['customData']['creatorProof']);
	}

	public function testUnsignedOwnCreatorIsCanonicalizedToActor(): void {
		$file = $this->mockEmptyFile();
		$captured = $this->captureWrite($file);

		$this->updateContent($file, [
			'data' => [
				'elements' => [[
					'id' => 'own-element',
					'type' => 'rectangle',
					'customData' => [
						'creator' => ['uid' => 'admin', 'displayName' => 'Forged display name', 'createdAt' => 1],
					],
				]],
			],
		], $this->actor('admin', 'Admin'));

		$creator = $captured->data['elements'][0]['customData']['creator'];
		$this->assertSame('admin', $creator['uid']);
		$this->assertSame('Admin', $creator['displayName']);
		$this->assertMatchesRegularExpression('/^v1:[a-f0-9]{64}$/', $captured->data['elements'][0]['customData']['creatorProof']);
	}

	public function testInvalidOwnCreatorProofIsReplaced(): void {
		$file = $this->mockEmptyFile();
		$captured = $this->captureWrite($file);
		$invalidProof = 'v1:' . str_repeat('0', 64);

		$this->updateContent($file, [
			'data' => [
				'elements' => [[
					'id' => 'own-element',
					'type' => 'rectangle',
					'customData' => [
						'creator' => ['uid' => 'admin', 'displayName' => 'Admin', 'createdAt' => 1],
						'creatorProof' => $invalidProof,
					],
				]],
			],
		], $this->actor('admin', 'Admin'));

		$this->assertSame('admin', $captured->data['elements'][0]['customData']['creator']['uid']);
		$this->assertNotSame($invalidProof, $captured->data['elements'][0]['customData']['creatorProof']);
	}

	public function testSyncerPreservesCreatorAttestedByCollaborationServer(): void {
		$file = $this->mockEmptyFile();
		$captured = $this->captureWrite($file);

		$this->updateContent($file, [
			'data' => [
				'elements' => [[
					'id' => 'peer-element',
					'type' => 'rectangle',
					'customData' => [
						'creator' => ['uid' => 'alice', 'displayName' => 'Alice', 'createdAt' => 1773915810534],
						'creatorProof' => self::CREATOR_PROOF,
					],
				]],
			],
		], $this->actor('bob', 'Bob'));

		$this->assertSame('alice', $captured->data['elements'][0]['customData']['creator']['uid']);
		$this->assertSame(self::CREATOR_PROOF, $captured->data['elements'][0]['customData']['creatorProof']);
	}

	public function testPublicLinkCreatorDoesNotExposeShareToken(): void {
		$file = $this->mockEmptyFile();
		$captured = $this->captureWrite($file);

		$this->updateContent($file, [
			'data' => [
				'elements' => [['id' => 'public-element', 'type' => 'rectangle']],
			],
		], new PublicSharingUser('token-value'));

		$creator = $captured->data['elements'][0]['customData']['creator'];
		$this->assertSame('public-link:e6c02a5742ea9d4d', $creator['uid']);
		$this->assertSame('Public link', $creator['displayName']);
		$this->assertStringNotContainsString('token-value', $captured->data['elements'][0]['customData']['creatorProof']);
	}

	public function testCreatorProofCannotBeReplayedForAnotherElement(): void {
		$file = $this->mockEmptyFile();
		$captured = $this->captureWrite($file);

		$this->updateContent($file, [
			'data' => [
				'elements' => [[
					'id' => 'other-element',
					'type' => 'rectangle',
					'customData' => [
						'creator' => ['uid' => 'alice', 'displayName' => 'Alice', 'createdAt' => 1773915810534],
						'creatorProof' => self::CREATOR_PROOF,
					],
				]],
			],
		], $this->actor('bob', 'Bob'));

		$this->assertSame('bob', $captured->data['elements'][0]['customData']['creator']['uid']);
		$this->assertNotSame(self::CREATOR_PROOF, $captured->data['elements'][0]['customData']['creatorProof']);
	}

	public function testStoredCreatorWinsOnExistingElement(): void {
		$file = $this->mockFileWithContent([
			'elements' => [[
				'id' => 'existing-element',
				'type' => 'rectangle',
				'version' => 1,
				'customData' => [
					'creator' => ['uid' => 'bob', 'displayName' => 'Bob', 'createdAt' => 10],
				],
			]],
			'files' => [],
		]);
		$captured = $this->captureWrite($file);

		$this->updateContent($file, [
			'data' => [
				'elements' => [[
					'id' => 'existing-element',
					'type' => 'diamond',
					'version' => 2,
					'customData' => [
						'creator' => ['uid' => 'mallory', 'displayName' => 'Mallory', 'createdAt' => 1],
					],
				]],
			],
		], $this->actor('alice', 'Alice'));

		$this->assertSame('bob', $captured->data['elements'][0]['customData']['creator']['uid']);
		$this->assertArrayNotHasKey('creatorProof', $captured->data['elements'][0]['customData']);
		$this->assertSame('diamond', $captured->data['elements'][0]['type']);
	}

	public function testStoredValidCreatorProofIsPreserved(): void {
		$file = $this->mockFileWithContent([
			'elements' => [[
				'id' => 'peer-element',
				'type' => 'rectangle',
				'version' => 1,
				'customData' => [
					'creator' => ['uid' => 'alice', 'displayName' => 'Alice', 'createdAt' => 1773915810534],
					'creatorProof' => self::CREATOR_PROOF,
				],
			]],
			'files' => [],
		]);
		$captured = $this->captureWrite($file);

		$this->updateContent($file, [
			'data' => [
				'elements' => [[
					'id' => 'peer-element',
					'type' => 'diamond',
					'version' => 2,
				]],
			],
		], $this->actor('bob', 'Bob'));

		$this->assertSame('alice', $captured->data['elements'][0]['customData']['creator']['uid']);
		$this->assertSame(self::CREATOR_PROOF, $captured->data['elements'][0]['customData']['creatorProof']);
	}

	public function testCreatorCanonicalizationLeavesOtherCustomDataUntouched(): void {
		$file = $this->mockEmptyFile();
		$captured = $this->captureWrite($file);
		$commentThread = ['comments' => [['id' => 'comment', 'author' => 'Bob', 'text' => 'hello']]];
		$tableLock = ['uid' => 'bob', 'displayName' => 'Bob', 'lockedAt' => 10];

		$this->updateContent($file, [
			'data' => [
				'elements' => [[
					'id' => 'table',
					'type' => 'image',
					'customData' => [
						'isTable' => true,
						'tableLock' => $tableLock,
						'commentThread' => $commentThread,
					],
				]],
			],
		], $this->actor());

		$customData = $captured->data['elements'][0]['customData'];
		$this->assertEquals($tableLock, $customData['tableLock']);
		$this->assertEquals($commentThread, $customData['commentThread']);
	}

	#[DataProvider('blankContentProvider')]
	public function testBlankFileIsAnEmptyBoard(string $content): void {
		$file = $this->createStub(File::class);
		$file->method('getContent')->willReturn($content);

		$this->assertSame(['elements' => [], 'scrollToContent' => true], $this->service()->decode($file->getContent()));
	}

	public static function blankContentProvider(): array {
		return [
			'empty' => [''],
			'space from an object store' => [' '],
			'mixed whitespace' => [" \t\r\n"],
		];
	}

	public function testMalformedFileStillFails(): void {
		$file = $this->createStub(File::class);
		$file->method('getContent')->willReturn(' {"elements": ');

		$this->expectException(\JsonException::class);
		$this->service()->decode($file->getContent());
	}

	private function service(): WhiteboardContentService {
		return new WhiteboardContentService($this->configService());
	}

	/**
	 * Merges a save into the board stored in `$file` and writes it, as Nextcloud does
	 *
	 * @param File&MockObject $file
	 */
	private function updateContent(File $file, array $data, User $actor): void {
		$service = $this->service();
		$result = $service->merge($service->decode($file->getContent()), $data['data']['elements'] ?? [], $data['data']['files'] ?? [], $actor, 123, 1);
		if ($result['elements'] !== [] || $result['files'] !== []) {
			$file->putContent($service->encode($result['board']));
		}
	}

	/**
	 * The board after merging a save, or null when the save changes nothing
	 */
	private function save(array $stored, array $data, ?User $actor = null): ?array {
		$result = $this->service()->merge($stored, $data['elements'] ?? [], $data['files'] ?? [], $actor ?? $this->actor(), 123, 1);
		return $result['elements'] === [] && $result['files'] === [] ? null : $result['board'];
	}

	private function configService(): ConfigService {
		$appConfig = $this->createMock(IAppConfig::class);
		$appConfig->method('getAppValueString')->with('jwt_secret_key')->willReturn(self::SECRET);
		return new ConfigService($appConfig, $this->createMock(IConfig::class));
	}

	private function actor(string $uid = 'actor', string $displayName = 'Actor'): User {
		$actor = $this->createMock(User::class);
		$actor->method('getUID')->willReturn($uid);
		$actor->method('getDisplayName')->willReturn($displayName);
		return $actor;
	}

	public function testSaveKeepsTheExcalidrawFileType(): void {
		$file = $this->mockFileWithContent([
			'type' => 'excalidraw',
			'version' => 2,
			'source' => 'https://excalidraw.com',
			'elements' => [['id' => 'box', 'type' => 'rectangle', 'version' => 1, 'versionNonce' => 1]],
			'appState' => ['viewBackgroundColor' => '#ffffff'],
			'files' => [],
		]);
		$captured = $this->captureWrite($file);

		$this->updateContent($file, [
			'data' => [
				'elements' => [['id' => 'box', 'type' => 'rectangle', 'version' => 2, 'versionNonce' => 2]],
				'files' => [],
			],
		], $this->actor());

		$this->assertSame('excalidraw', $captured->data['type']);
		$this->assertSame(2, $captured->data['version']);
		$this->assertSame('https://excalidraw.com', $captured->data['source']);
	}

	public function testSaveAddsTheExcalidrawFileTypeToBoards(): void {
		$file = $this->mockEmptyFile();
		$captured = $this->captureWrite($file);

		$this->updateContent($file, [
			'data' => [
				'elements' => [['id' => 'box', 'type' => 'rectangle', 'version' => 1, 'versionNonce' => 1]],
				'files' => [],
			],
		], $this->actor());

		$this->assertSame('excalidraw', $captured->data['type']);
		$this->assertSame(2, $captured->data['version']);
		$this->assertArrayNotHasKey('source', $captured->data);
	}

	/** @return File&MockObject */
	private function mockEmptyFile(): File {
		$file = $this->createMock(File::class);
		$file->method('getId')->willReturn(123);
		$file->method('getContent')->willReturn('');
		return $file;
	}

	/** @return File&MockObject */
	private function mockFileWithContent(array $content): File {
		$file = $this->createMock(File::class);
		$file->method('getId')->willReturn(123);
		$file->method('getContent')->willReturn(json_encode($content, JSON_THROW_ON_ERROR));
		return $file;
	}

	/**
	 * Capture the JSON written via putContent as a decoded array on ->data.
	 *
	 * @param File&MockObject $file
	 */
	private function captureWrite(File $file): \stdClass {
		$captured = new \stdClass();
		$captured->data = null;
		$file->method('putContent')->willReturnCallback(static function (string $content) use ($captured): void {
			$captured->data = json_decode($content, true, 512, JSON_THROW_ON_ERROR);
		});
		return $captured;
	}
}
