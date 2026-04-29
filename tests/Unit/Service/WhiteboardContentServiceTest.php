<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use InvalidArgumentException;
use OCA\Whiteboard\Exception\WhiteboardConflictException;
use OCP\Files\File;
use Psr\Log\LoggerInterface;

class WhiteboardContentServiceTest extends \Test\TestCase {
	private WhiteboardContentService $service;

	protected function setUp(): void {
		parent::setUp();
		$this->service = new WhiteboardContentService(
			$this->createMock(LoggerInterface::class),
		);
	}

	public function testEmptyFileNormalizesToPersistedRevZero(): void {
		$file = $this->createFileMock('');

		$content = $this->service->getContent($file);

		self::assertSame([
			'meta' => [
				'persistedRev' => 0,
				'updatedAt' => null,
				'updatedBy' => null,
			],
			'elements' => [],
			'files' => [],
			'appState' => [],
			'scrollToContent' => true,
		], $content);
	}

	public function testLegacyFileNormalizesCorrectly(): void {
		$file = $this->createFileMock(json_encode([
			'elements' => [
				['id' => 'shape-1'],
			],
			'files' => [
				'file-a' => ['id' => 'file-a'],
			],
			'appState' => [
				'collaborators' => ['alice' => true],
				'viewBackgroundColor' => '#fff',
			],
			'scrollToContent' => false,
		], JSON_THROW_ON_ERROR));

		$content = $this->service->getContent($file);

		self::assertSame(0, $content['meta']['persistedRev']);
		self::assertSame(null, $content['meta']['updatedAt']);
		self::assertSame(null, $content['meta']['updatedBy']);
		self::assertSame([['id' => 'shape-1']], $content['elements']);
		self::assertSame(['file-a' => ['id' => 'file-a']], $content['files']);
		self::assertSame(['viewBackgroundColor' => '#fff'], $content['appState']);
		self::assertFalse($content['scrollToContent']);
	}

	public function testMatchingBaseRevIncrementsRevisionAndWritesUpdatedBy(): void {
		$writtenContent = null;
		$file = $this->createFileMock(
			json_encode([
				'elements' => [],
				'files' => [],
				'appState' => [],
				'scrollToContent' => true,
			], JSON_THROW_ON_ERROR),
			42,
			function (string $payload) use (&$writtenContent): int {
				$writtenContent = $payload;
				return 0;
			},
		);

		$meta = $this->service->updateContent($file, [
			'data' => [
				'baseRev' => 0,
				'elements' => [
					['id' => 'shape-1'],
				],
				'files' => [],
				'appState' => [
					'viewBackgroundColor' => '#fff',
				],
				'scrollToContent' => false,
			],
		], 'alice');

		self::assertSame(1, $meta['persistedRev']);
		self::assertSame('alice', $meta['updatedBy']);
		self::assertIsInt($meta['updatedAt']);
		self::assertNotNull($writtenContent);

		$stored = json_decode((string)$writtenContent, true, 512, JSON_THROW_ON_ERROR);
		self::assertSame(1, $stored['meta']['persistedRev']);
		self::assertSame('alice', $stored['meta']['updatedBy']);
		self::assertSame([['id' => 'shape-1']], $stored['elements']);
		self::assertFalse($stored['scrollToContent']);
	}

	public function testFirstSaveOfLegacyBoardWritesMetaEvenWhenSnapshotIsOtherwiseIdentical(): void {
		$writtenContent = null;
		$file = $this->createFileMock(
			json_encode([
				'elements' => [
					['id' => 'shape-1'],
				],
				'files' => [],
				'appState' => [],
				'scrollToContent' => true,
			], JSON_THROW_ON_ERROR),
			42,
			function (string $payload) use (&$writtenContent): int {
				$writtenContent = $payload;
				return 0;
			},
		);

		$meta = $this->service->updateContent($file, [
			'data' => [
				'baseRev' => 0,
				'elements' => [
					['id' => 'shape-1'],
				],
				'files' => [],
				'appState' => [],
				'scrollToContent' => true,
			],
		], 'alice');

		self::assertSame(1, $meta['persistedRev']);
		self::assertSame('alice', $meta['updatedBy']);
		self::assertNotNull($writtenContent);

		$stored = json_decode((string)$writtenContent, true, 512, JSON_THROW_ON_ERROR);
		self::assertSame(1, $stored['meta']['persistedRev']);
	}

	public function testStaleBaseRevWithDifferentContentReturnsConflictPayload(): void {
		$file = $this->createFileMock(json_encode([
			'meta' => [
				'persistedRev' => 8,
				'updatedAt' => 1743494412345,
				'updatedBy' => 'bob',
			],
			'elements' => [
				['id' => 'server-shape'],
			],
			'files' => [],
			'appState' => [],
			'scrollToContent' => true,
		], JSON_THROW_ON_ERROR));

		try {
			$this->service->updateContent($file, [
				'data' => [
					'baseRev' => 7,
					'elements' => [
						['id' => 'local-shape'],
					],
					'files' => [],
					'appState' => [],
					'scrollToContent' => true,
				],
			], 'alice');
			self::fail('Expected WhiteboardConflictException to be thrown');
		} catch (WhiteboardConflictException $e) {
			self::assertSame(8, $e->getCurrentDocument()['meta']['persistedRev']);
			self::assertSame('bob', $e->getCurrentDocument()['meta']['updatedBy']);
			self::assertSame([['id' => 'server-shape']], $e->getCurrentDocument()['elements']);
		}
	}

	public function testStaleBaseRevWithIdenticalContentIsIdempotentSuccess(): void {
		$file = $this->createFileMock(
			json_encode([
				'meta' => [
					'persistedRev' => 8,
					'updatedAt' => 1743494412345,
					'updatedBy' => 'bob',
				],
				'elements' => [
					['id' => 'shape-1'],
				],
				'files' => [
					'file-b' => ['id' => 'file-b'],
					'file-a' => ['id' => 'file-a'],
				],
				'appState' => [
					'viewBackgroundColor' => '#fff',
				],
				'scrollToContent' => false,
			], JSON_THROW_ON_ERROR),
			42,
			function (string $_payload): int {
				self::fail('putContent should not be called for idempotent saves');
				return 0;
			},
		);

		$meta = $this->service->updateContent($file, [
			'data' => [
				'baseRev' => 2,
				'elements' => [
					['id' => 'shape-1'],
				],
				'files' => [
					'file-a' => ['id' => 'file-a'],
					'file-b' => ['id' => 'file-b'],
				],
				'appState' => [
					'collaborators' => ['alice' => true],
					'viewBackgroundColor' => '#fff',
				],
				'scrollToContent' => false,
			],
		], 'alice');

		self::assertSame([
			'persistedRev' => 8,
			'updatedAt' => 1743494412345,
			'updatedBy' => 'bob',
		], $meta);
	}

	public function testInvalidBaseRevReturnsBadRequest(): void {
		$file = $this->createFileMock('');

		$this->expectException(InvalidArgumentException::class);
		$this->expectExceptionMessage('baseRev');

		$this->service->updateContent($file, [
			'data' => [
				'baseRev' => 'seven',
				'elements' => [],
				'files' => [],
				'appState' => [],
				'scrollToContent' => true,
			],
		], 'alice');
	}

	public function testMalformedPayloadReturnsBadRequest(): void {
		$file = $this->createFileMock('');

		$this->expectException(InvalidArgumentException::class);
		$this->expectExceptionMessage('elements');

		$this->service->updateContent($file, [
			'data' => [
				'baseRev' => 0,
				'files' => [],
				'appState' => [],
				'scrollToContent' => true,
			],
		], 'alice');
	}

	/**
	 * @param callable(string):int|null $putContentHandler
	 */
	private function createFileMock(string $content, int $fileId = 42, ?callable $putContentHandler = null): File {
		$file = $this->createMock(File::class);
		$file->method('getId')->willReturn($fileId);
		$file->method('getContent')->willReturn($content);

		if ($putContentHandler !== null) {
			$file->method('putContent')->willReturnCallback($putContentHandler);
		}

		return $file;
	}
}
