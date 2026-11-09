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

	public function testAStoredLibraryNameThatIsNoFileNameIsDropped(): void {
		$board = $this->service()->forClient(['elements' => [], 'libraryRef' => ['scope' => 'personal', 'name' => 'a/b']]);

		$this->assertArrayNotHasKey('libraryRef', $board);
	}

	public function testStoredLibraryItemsLoseWhereTheyCameFrom(): void {
		$board = $this->service()->forClient(['elements' => [], 'libraryItems' => [
			['id' => 'item', 'elements' => [['type' => 'ellipse']], 'libraryName' => 'Kit', 'scope' => 'org'],
		]]);

		$this->assertSame([['id' => 'item', 'elements' => [['type' => 'ellipse']]]], $board['libraryItems']);
	}

	public function testElementsNumberedByAnotherToolStayOnTheBoard(): void {
		$board = $this->save([
			'elements' => [
				['id' => 1, 'type' => 'rectangle', 'version' => 1, 'versionNonce' => 1],
				['id' => 'b', 'type' => 'rectangle', 'version' => 1, 'versionNonce' => 1],
			],
		], [
			'elements' => [['id' => 'b', 'type' => 'rectangle', 'version' => 2, 'versionNonce' => 2]],
		]);

		$this->assertSame(['1', 'b'], array_column($board['elements'], 'id'));
	}

	public function testReferencesToElementsNumberedByAnotherToolFollowTheirIds(): void {
		$board = $this->save([
			'elements' => [
				['id' => 7, 'type' => 'frame', 'version' => 1, 'versionNonce' => 1],
				['id' => 8, 'type' => 'rectangle', 'version' => 1, 'versionNonce' => 1, 'frameId' => 7, 'boundElements' => [['id' => 9, 'type' => 'text'], ['id' => 'a', 'type' => 'arrow']]],
				['id' => 9, 'type' => 'text', 'version' => 1, 'versionNonce' => 1, 'containerId' => 8],
				['id' => 'a', 'type' => 'arrow', 'version' => 1, 'versionNonce' => 1, 'startBinding' => ['elementId' => 8], 'endBinding' => ['elementId' => 7]],
			],
		], [
			'elements' => [['id' => 'b', 'type' => 'rectangle', 'version' => 1, 'versionNonce' => 1]],
		]);

		$byId = array_column($board['elements'], null, 'id');
		$this->assertSame('7', $byId['8']['frameId']);
		$this->assertSame(['9', 'a'], array_column($byId['8']['boundElements'], 'id'));
		$this->assertSame('8', $byId['9']['containerId']);
		$this->assertSame('8', $byId['a']['startBinding']['elementId']);
		$this->assertSame('7', $byId['a']['endBinding']['elementId']);
	}

	/** @return array<string,array{array<string,int>,array<string,int>,bool}> */
	public static function winOrder(): array {
		$contract = json_decode((string)file_get_contents(__DIR__ . '/../../fixtures/board-sync-contract.json'), true);
		$cases = [];
		foreach ($contract['wins'] as $i => $case) {
			$cases['case ' . $i] = [$case['copy'], $case['stored'], $case['wins']];
		}
		return $cases;
	}

	/**
	 * The order clients use as well (`src/sync/elementOrder.ts`), from the shared fixture
	 *
	 * @param array<string,int> $copy
	 * @param array<string,int> $stored
	 */
	#[DataProvider('winOrder')]
	public function testACopyReplacesTheStoredOneInTheClientsOrder(array $copy, array $stored, bool $wins): void {
		$board = $this->save(['elements' => [['id' => 'a', 'type' => 'rectangle', 'marker' => 'stored'] + $stored]], [
			'elements' => [['id' => 'a', 'type' => 'rectangle', 'marker' => 'copy'] + $copy],
		]);

		$this->assertSame($wins ? 'copy' : 'stored', $board === null ? 'stored' : $board['elements'][0]['marker']);
	}

	/** @return array<string,array{list<array<string,string>>,list<string>}> */
	public static function elementOrder(): array {
		$contract = json_decode((string)file_get_contents(__DIR__ . '/../../fixtures/board-sync-contract.json'), true);
		$cases = [];
		foreach ($contract['order'] as $i => $case) {
			$cases['case ' . $i] = [$case['elements'], $case['ids']];
		}
		return $cases;
	}

	/**
	 * The element order clients use as well (`inIndexOrder` in `src/sync/elementOrder.ts`), from the shared fixture
	 *
	 * @param list<array<string,string>> $elements
	 * @param list<string> $ids
	 */
	#[DataProvider('elementOrder')]
	public function testAMergedBoardKeepsTheClientsElementOrder(array $elements, array $ids): void {
		$stored = array_map(static fn (array $element) => $element + ['type' => 'rectangle', 'version' => 1, 'versionNonce' => 1], $elements);
		$board = $this->save(['elements' => $stored], ['elements' => [['version' => 2] + $stored[0]]]);

		$this->assertSame($ids, array_column($board['elements'] ?? [], 'id'));
	}

	public function testChangedFilesAreListedByTheirIdAsAString(): void {
		$result = $this->service()->merge(['elements' => []], [], ['123' => ['id' => '123', 'mimeType' => 'image/png', 'dataURL' => 'data:image/png;base64,AAAA']], $this->actor(), 123, 1);

		$this->assertSame(['123'], $result['files']);
	}

	public function testOnlyTheBoardSettingsClientsKnowAreSaved(): void {
		$contract = json_decode((string)file_get_contents(__DIR__ . '/../../fixtures/board-sync-contract.json'), true);
		$valid = ['viewBackgroundColor' => '#ffec99', 'gridSize' => 40, 'gridStep' => 4, 'theme' => 'dark'];

		$result = $this->service()->merge(['elements' => []], [], [], $this->actor(), 123, 1, $valid);

		$this->assertEqualsCanonicalizing($contract['boardSettings'], $result['settings']);
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

	public function testBoardSettingsAreSavedWithTheirRevision(): void {
		$result = $this->service()->merge([
			'elements' => [],
			'appState' => ['viewBackgroundColor' => '#ffffff', 'zoom' => ['value' => 2]],
			'revisions' => ['elements' => [], 'files' => []],
		], [], [], $this->actor(), 123, 4, ['viewBackgroundColor' => '#ffec99']);

		$this->assertSame(['viewBackgroundColor'], $result['settings']);
		$this->assertSame('#ffec99', $result['board']['appState']['viewBackgroundColor']);
		$this->assertSame(['value' => 2], $result['board']['appState']['zoom']);
		$this->assertSame(['viewBackgroundColor' => 4], $result['board']['revisions']['settings']);
		$this->assertSame(['viewBackgroundColor' => '#ffec99'], $this->service()->changesSince($result['board'], 3)['settings']);
		$this->assertSame([], $this->service()->changesSince($result['board'], 4)['settings']);
		$this->assertSame(4, $this->service()->latestRevision($result['board']));
	}

	public function testOnlyBoardSettingsWithValidValuesAreSaved(): void {
		$result = $this->service()->merge(['elements' => []], [], [], $this->actor(), 123, 2, [
			'zoom' => ['value' => 3],
			'viewBackgroundColor' => 12,
			'gridSize' => 10,
			'gridStep' => -1,
		]);

		$this->assertSame(['gridSize'], $result['settings']);
		$this->assertSame(['gridSize' => 10], $result['board']['appState']);
	}

	public function testUnchangedBoardSettingsWriteNothing(): void {
		$result = $this->service()->merge(['elements' => [], 'appState' => ['viewBackgroundColor' => '#ffec99']], [], [], $this->actor(), 123, 2, ['viewBackgroundColor' => '#ffec99']);

		$this->assertSame([], $result['settings']);
		$this->assertSame([], $result['elements']);
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
		$stored = $this->stored([
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

		$merged = $this->merged($stored, [
			'elements' => [[
				'id' => 'arrow',
				'type' => 'arrow',
				'version' => 7,
				'versionNonce' => 42,
				'startBinding' => ['elementId' => 'box', 'fixedPoint' => [0.5, 1], 'mode' => 'orbit'],
			]],
			'files' => [],
			'scrollToContent' => true,
		], $this->actor());

		$this->assertSame([[], []], [$merged['elements'], $merged['files']]);
	}

	public function testSaveWithChangedElementVersionWrites(): void {
		$stored = $this->stored([
			'elements' => [['id' => 'box', 'type' => 'rectangle', 'version' => 7, 'versionNonce' => 42, 'width' => 10]],
			'files' => [],
			'scrollToContent' => true,
		]);

		$merged = $this->merged($stored, [
			'elements' => [['id' => 'box', 'type' => 'rectangle', 'version' => 8, 'versionNonce' => 43, 'width' => 20]],
			'files' => [],
			'scrollToContent' => true,
		], $this->actor());

		$this->assertSame(20, $merged['board']['elements'][0]['width']);
	}

	public function testDirectSaveCanonicalizesForgedCreatorToActor(): void {
		$stored = $this->stored([]);

		$merged = $this->merged($stored, [
			'elements' => [[
				'id' => 'forged-element',
				'type' => 'text',
				'text' => 'We should rewrite Nextcloud in Rust',
				'customData' => [
					'creator' => ['uid' => 'bob', 'displayName' => 'Bob', 'createdAt' => 1],
					'creatorProof' => 'v1:' . str_repeat('0', 64),
				],
			]],
		], $this->actor('admin', 'Admin'));

		$creator = $merged['board']['elements'][0]['customData']['creator'];
		$this->assertSame('admin', $creator['uid']);
		$this->assertSame('Admin', $creator['displayName']);
		$this->assertMatchesRegularExpression('/^v1:[a-f0-9]{64}$/', $merged['board']['elements'][0]['customData']['creatorProof']);
	}

	public function testUnsignedOwnCreatorIsCanonicalizedToActor(): void {
		$stored = $this->stored([]);

		$merged = $this->merged($stored, [
			'elements' => [[
				'id' => 'own-element',
				'type' => 'rectangle',
				'customData' => [
					'creator' => ['uid' => 'admin', 'displayName' => 'Forged display name', 'createdAt' => 1],
				],
			]],
		], $this->actor('admin', 'Admin'));

		$creator = $merged['board']['elements'][0]['customData']['creator'];
		$this->assertSame('admin', $creator['uid']);
		$this->assertSame('Admin', $creator['displayName']);
		$this->assertMatchesRegularExpression('/^v1:[a-f0-9]{64}$/', $merged['board']['elements'][0]['customData']['creatorProof']);
	}

	public function testInvalidOwnCreatorProofIsReplaced(): void {
		$stored = $this->stored([]);
		$invalidProof = 'v1:' . str_repeat('0', 64);

		$merged = $this->merged($stored, [
			'elements' => [[
				'id' => 'own-element',
				'type' => 'rectangle',
				'customData' => [
					'creator' => ['uid' => 'admin', 'displayName' => 'Admin', 'createdAt' => 1],
					'creatorProof' => $invalidProof,
				],
			]],
		], $this->actor('admin', 'Admin'));

		$this->assertSame('admin', $merged['board']['elements'][0]['customData']['creator']['uid']);
		$this->assertNotSame($invalidProof, $merged['board']['elements'][0]['customData']['creatorProof']);
	}

	public function testSyncerPreservesCreatorAttestedByCollaborationServer(): void {
		$stored = $this->stored([]);

		$merged = $this->merged($stored, [
			'elements' => [[
				'id' => 'peer-element',
				'type' => 'rectangle',
				'customData' => [
					'creator' => ['uid' => 'alice', 'displayName' => 'Alice', 'createdAt' => 1773915810534],
					'creatorProof' => self::CREATOR_PROOF,
				],
			]],
		], $this->actor('bob', 'Bob'));

		$this->assertSame('alice', $merged['board']['elements'][0]['customData']['creator']['uid']);
		$this->assertSame(self::CREATOR_PROOF, $merged['board']['elements'][0]['customData']['creatorProof']);
	}

	public function testPublicLinkCreatorDoesNotExposeShareToken(): void {
		$stored = $this->stored([]);

		$merged = $this->merged($stored, [
			'elements' => [['id' => 'public-element', 'type' => 'rectangle']],
		], new PublicSharingUser('token-value'));

		$creator = $merged['board']['elements'][0]['customData']['creator'];
		$this->assertSame('public-link:e6c02a5742ea9d4d', $creator['uid']);
		$this->assertSame('Public link', $creator['displayName']);
		$this->assertStringNotContainsString('token-value', $merged['board']['elements'][0]['customData']['creatorProof']);
	}

	public function testCreatorProofCannotBeReplayedForAnotherElement(): void {
		$stored = $this->stored([]);

		$merged = $this->merged($stored, [
			'elements' => [[
				'id' => 'other-element',
				'type' => 'rectangle',
				'customData' => [
					'creator' => ['uid' => 'alice', 'displayName' => 'Alice', 'createdAt' => 1773915810534],
					'creatorProof' => self::CREATOR_PROOF,
				],
			]],
		], $this->actor('bob', 'Bob'));

		$this->assertSame('bob', $merged['board']['elements'][0]['customData']['creator']['uid']);
		$this->assertNotSame(self::CREATOR_PROOF, $merged['board']['elements'][0]['customData']['creatorProof']);
	}

	public function testStoredCreatorWinsOnExistingElement(): void {
		$stored = $this->stored([
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

		$merged = $this->merged($stored, [
			'elements' => [[
				'id' => 'existing-element',
				'type' => 'diamond',
				'version' => 2,
				'customData' => [
					'creator' => ['uid' => 'mallory', 'displayName' => 'Mallory', 'createdAt' => 1],
				],
			]],
		], $this->actor('alice', 'Alice'));

		$this->assertSame('bob', $merged['board']['elements'][0]['customData']['creator']['uid']);
		$this->assertArrayNotHasKey('creatorProof', $merged['board']['elements'][0]['customData']);
		$this->assertSame('diamond', $merged['board']['elements'][0]['type']);
	}

	public function testStoredValidCreatorProofIsPreserved(): void {
		$stored = $this->stored([
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

		$merged = $this->merged($stored, [
			'elements' => [[
				'id' => 'peer-element',
				'type' => 'diamond',
				'version' => 2,
			]],
		], $this->actor('bob', 'Bob'));

		$this->assertSame('alice', $merged['board']['elements'][0]['customData']['creator']['uid']);
		$this->assertSame(self::CREATOR_PROOF, $merged['board']['elements'][0]['customData']['creatorProof']);
	}

	public function testCreatorCanonicalizationLeavesOtherCustomDataUntouched(): void {
		$stored = $this->stored([]);
		$commentThread = ['comments' => [['id' => 'comment', 'author' => 'Bob', 'text' => 'hello']]];
		$tableLock = ['uid' => 'bob', 'displayName' => 'Bob', 'lockedAt' => 10];

		$merged = $this->merged($stored, [
			'elements' => [[
				'id' => 'table',
				'type' => 'image',
				'customData' => [
					'isTable' => true,
					'tableLock' => $tableLock,
					'commentThread' => $commentThread,
				],
			]],
		], $this->actor());

		$customData = $merged['board']['elements'][0]['customData'];
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

	public function testAJsonListIsNoBoard(): void {
		$this->expectException(\JsonException::class);
		$this->service()->decode('[1, 2]');
	}

	private function service(): WhiteboardContentService {
		return new WhiteboardContentService($this->configService());
	}

	/**
	 * The board stored in the bytes of `$content`; blank bytes for an empty array
	 *
	 * @return array<string,mixed>
	 */
	private function stored(array $content): array {
		return $this->service()->decode($content === [] ? '' : json_encode($content, JSON_THROW_ON_ERROR));
	}

	/**
	 * What a save merges into the stored board, with the board as it is written and read back
	 *
	 * @return array{board: array<string,mixed>, elements: list<string>, files: list<string>, settings: list<string>}
	 */
	private function merged(array $stored, array $data, User $actor): array {
		$service = $this->service();
		$result = $service->merge($stored, $data['elements'] ?? [], $data['files'] ?? [], $actor, 123, 1);
		return ['board' => $service->decode($service->encode($result['board']))] + $result;
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
		$stored = $this->stored([
			'type' => 'excalidraw',
			'version' => 2,
			'source' => 'https://excalidraw.com',
			'elements' => [['id' => 'box', 'type' => 'rectangle', 'version' => 1, 'versionNonce' => 1]],
			'appState' => ['viewBackgroundColor' => '#ffffff'],
			'files' => [],
		]);

		$merged = $this->merged($stored, [
			'elements' => [['id' => 'box', 'type' => 'rectangle', 'version' => 2, 'versionNonce' => 2]],
			'files' => [],
		], $this->actor());

		$this->assertSame('excalidraw', $merged['board']['type']);
		$this->assertSame(2, $merged['board']['version']);
		$this->assertSame('https://excalidraw.com', $merged['board']['source']);
	}

	public function testSaveAddsTheExcalidrawFileTypeToBoards(): void {
		$stored = $this->stored([]);

		$merged = $this->merged($stored, [
			'elements' => [['id' => 'box', 'type' => 'rectangle', 'version' => 1, 'versionNonce' => 1]],
			'files' => [],
		], $this->actor());

		$this->assertSame('excalidraw', $merged['board']['type']);
		$this->assertSame(2, $merged['board']['version']);
		$this->assertArrayNotHasKey('source', $merged['board']);
	}
}
