<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Listener;

use OCP\Files\File;
use OCP\Files\Template\FileCreatedFromTemplateEvent;
use Psr\Log\LoggerInterface;
use Test\TestCase;

class FileCreatedFromTemplateListenerTest extends TestCase {
	public function testEmbedsLibraryItemsIntoNewWhiteboard(): void {
		$template = $this->createMock(File::class);
		$template->method('getName')->willReturn('Flowchart.excalidrawlib');
		$template->method('getPath')->willReturn('/appdata/whiteboard/global-libraries/Flowchart.excalidrawlib');
		$template->method('getContent')->willReturn(json_encode([
			'type' => 'excalidrawlib',
			'version' => 2,
			'libraryItems' => [
				[
					'id' => 'item-1',
					'status' => 'published',
					'elements' => [
						['id' => 'element-1', 'type' => 'rectangle'],
					],
				],
			],
		], JSON_THROW_ON_ERROR));

		$target = $this->createMock(File::class);
		$target->method('getName')->willReturn('New whiteboard.whiteboard');
		$target->method('getPath')->willReturn('/admin/files/New whiteboard.whiteboard');
		$target->expects($this->once())
			->method('putContent')
			->with($this->callback(static function (string $content): bool {
				$data = json_decode($content, true, 512, JSON_THROW_ON_ERROR);
				return $data['elements'] === []
					&& $data['files'] === []
					&& $data['scrollToContent'] === true
					&& count($data['libraryItems']) === 1
					&& $data['libraryItems'][0]['id'] === 'item-1';
			}));

		$listener = new FileCreatedFromTemplateListener($this->createMock(LoggerInterface::class));
		$listener->handle(new FileCreatedFromTemplateEvent($template, $target, []));
	}

	public function testAcceptsLegacyLibraryFormat(): void {
		$template = $this->createMock(File::class);
		$template->method('getName')->willReturn('Legacy.excalidrawlib');
		$template->method('getPath')->willReturn('/appdata/whiteboard/global-libraries/Legacy.excalidrawlib');
		$template->method('getContent')->willReturn(json_encode([
			'type' => 'excalidrawlib',
			'library' => [
				[
					['id' => 'element-1', 'type' => 'diamond'],
				],
			],
		], JSON_THROW_ON_ERROR));

		$target = $this->createMock(File::class);
		$target->method('getName')->willReturn('New whiteboard.whiteboard');
		$target->method('getPath')->willReturn('/admin/files/New whiteboard.whiteboard');
		$target->expects($this->once())
			->method('putContent')
			->with($this->callback(static function (string $content): bool {
				$data = json_decode($content, true, 512, JSON_THROW_ON_ERROR);
				return count($data['libraryItems']) === 1
					&& $data['libraryItems'][0]['status'] === 'published'
					&& $data['libraryItems'][0]['elements'][0]['type'] === 'diamond';
			}));

		$listener = new FileCreatedFromTemplateListener($this->createMock(LoggerInterface::class));
		$listener->handle(new FileCreatedFromTemplateEvent($template, $target, []));
	}
}
