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
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;
use Test\TestCase;

class WhiteboardContentServiceTest extends TestCase {
	private const CREATOR_PROOF = 'v1:31a3f15ad65d53e0b630d98a4fb2fbb9d629c4cb36992ba211c04f69304665bf';
	private const SECRET = 'test-secret';

	public function testNormalSaveKeepsEmbeddedLibraryItems(): void {
		$file = $this->createMock(File::class);
		$file->method('getId')->willReturn(123);
		$file->method('getContent')->willReturn(json_encode([
			'elements' => [
				['id' => 'old-element', 'type' => 'rectangle'],
			],
			'files' => [],
			'libraryItems' => [
				[
					'id' => 'library-item-1',
					'elements' => [
						['id' => 'library-element-1', 'type' => 'ellipse'],
					],
				],
			],
			'scrollToContent' => true,
		], JSON_THROW_ON_ERROR));

		$file->expects($this->once())
			->method('putContent')
			->with($this->callback(static function (string $content): bool {
				$data = json_decode($content, true, 512, JSON_THROW_ON_ERROR);
				return $data['elements'][0]['id'] === 'new-element'
					&& $data['libraryItems'][0]['id'] === 'library-item-1'
					&& !isset($data['libraryMode'])
					&& !isset($data['librarySource']);
			}));

		$this->service()->updateContent($file, [
			'data' => [
				'elements' => [
					['id' => 'new-element', 'type' => 'diamond'],
				],
				'files' => [],
				'scrollToContent' => true,
			],
		], $this->actor());
	}

	public function testValidLibraryRefIsPersisted(): void {
		$file = $this->mockEmptyFile();
		$captured = $this->captureWrite($file);

		$this->service()->updateContent($file, [
			'data' => [
				'elements' => [['id' => 'el', 'type' => 'rectangle']],
				'files' => [],
				'libraryRef' => ['scope' => 'org', 'name' => 'Brand kit'],
			],
		], $this->actor());

		// canonicalize() ksorts associative arrays, so compare order-insensitively.
		$this->assertEquals(['scope' => 'org', 'name' => 'Brand kit'], $captured->data['libraryRef']);
	}

	public function testInvalidLibraryRefNamesAreDropped(): void {
		$file = $this->mockEmptyFile();
		$captured = $this->captureWrite($file);

		$this->service()->updateContent($file, [
			'data' => [
				'elements' => [['id' => 'el', 'type' => 'rectangle']],
				'files' => [],
				'libraryRef' => ['scope' => 'personal', 'name' => 'a/b'],
			],
		], $this->actor());

		$this->assertArrayNotHasKey('libraryRef', $captured->data);
	}

	public function testNullLibraryRefRemovesStoredRef(): void {
		$file = $this->mockFileWithContent([
			'elements' => [['id' => 'el', 'type' => 'rectangle']],
			'files' => [],
			'libraryRef' => ['scope' => 'personal', 'name' => 'Kit'],
		]);
		$captured = $this->captureWrite($file);

		$this->service()->updateContent($file, [
			'data' => [
				'elements' => [['id' => 'el2', 'type' => 'diamond']],
				'files' => [],
				'libraryRef' => null,
			],
		], $this->actor());

		$this->assertArrayNotHasKey('libraryRef', $captured->data);
	}

	public function testEmbeddedLibraryItemsLoseReadOnlyTag(): void {
		$file = $this->mockEmptyFile();
		$captured = $this->captureWrite($file);

		$this->service()->updateContent($file, [
			'data' => [
				'elements' => [['id' => 'el', 'type' => 'rectangle']],
				'files' => [],
				'libraryItems' => [
					['id' => 'item', 'elements' => [['type' => 'ellipse']], 'libraryName' => 'Kit', 'scope' => 'org'],
				],
			],
		], $this->actor());

		$this->assertArrayNotHasKey('libraryName', $captured->data['libraryItems'][0]);
		$this->assertArrayNotHasKey('scope', $captured->data['libraryItems'][0]);
	}

	public function testDirectSaveCanonicalizesForgedCreatorToActor(): void {
		$file = $this->mockEmptyFile();
		$captured = $this->captureWrite($file);

		$this->service()->updateContent($file, [
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

		$this->service()->updateContent($file, [
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

		$this->service()->updateContent($file, [
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

		$this->service()->updateContent($file, [
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

		$this->service()->updateContent($file, [
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

		$this->service()->updateContent($file, [
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
				'customData' => [
					'creator' => ['uid' => 'bob', 'displayName' => 'Bob', 'createdAt' => 10],
				],
			]],
			'files' => [],
		]);
		$captured = $this->captureWrite($file);

		$this->service()->updateContent($file, [
			'data' => [
				'elements' => [[
					'id' => 'existing-element',
					'type' => 'diamond',
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
				'customData' => [
					'creator' => ['uid' => 'alice', 'displayName' => 'Alice', 'createdAt' => 1773915810534],
					'creatorProof' => self::CREATOR_PROOF,
				],
			]],
			'files' => [],
		]);
		$captured = $this->captureWrite($file);

		$this->service()->updateContent($file, [
			'data' => [
				'elements' => [[
					'id' => 'peer-element',
					'type' => 'diamond',
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

		$this->service()->updateContent($file, [
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

	private function service(): WhiteboardContentService {
		return new WhiteboardContentService($this->createMock(LoggerInterface::class), $this->configService());
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
