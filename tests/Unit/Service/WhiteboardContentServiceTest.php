<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use OCP\Files\File;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;
use Test\TestCase;

class WhiteboardContentServiceTest extends TestCase {
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

		$service = new WhiteboardContentService($this->createMock(LoggerInterface::class));
		$service->updateContent($file, [
			'data' => [
				'elements' => [
					['id' => 'new-element', 'type' => 'diamond'],
				],
				'files' => [],
				'scrollToContent' => true,
			],
		]);
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
		]);

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
		]);

		$this->assertArrayNotHasKey('libraryRef', $captured->data);
	}

	public function testNullLibraryRefRemovesStoredRef(): void {
		$file = $this->createMock(File::class);
		$file->method('getId')->willReturn(123);
		$file->method('getContent')->willReturn(json_encode([
			'elements' => [['id' => 'el', 'type' => 'rectangle']],
			'files' => [],
			'libraryRef' => ['scope' => 'personal', 'name' => 'Kit'],
		], JSON_THROW_ON_ERROR));
		$captured = $this->captureWrite($file);

		$this->service()->updateContent($file, [
			'data' => [
				'elements' => [['id' => 'el2', 'type' => 'diamond']],
				'files' => [],
				'libraryRef' => null,
			],
		]);

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
		]);

		$this->assertArrayNotHasKey('libraryName', $captured->data['libraryItems'][0]);
		$this->assertArrayNotHasKey('scope', $captured->data['libraryItems'][0]);
	}

	private function service(): WhiteboardContentService {
		return new WhiteboardContentService($this->createMock(LoggerInterface::class));
	}

	/** @return File&MockObject */
	private function mockEmptyFile(): File {
		$file = $this->createMock(File::class);
		$file->method('getId')->willReturn(123);
		$file->method('getContent')->willReturn('');
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
