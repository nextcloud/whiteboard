<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Controller;

use OCA\Whiteboard\Service\CanvasTemplateService;
use OCA\Whiteboard\Service\WhiteboardFolderService;
use OCA\Whiteboard\Service\WhiteboardLibraryService;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;
use OCP\Files\Template\ITemplateManager;
use OCP\IConfig;
use OCP\IRequest;
use OCP\IUser;
use OCP\IUserSession;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;
use Test\TestCase;

class PickerControllerTest extends TestCase {
	/** @return File&MockObject */
	private function mockFile(int $id, string $name, string $content, ?int $size = null): File {
		$file = $this->createMock(File::class);
		$file->method('getId')->willReturn($id);
		$file->method('getName')->willReturn($name);
		$file->method('getContent')->willReturn($content);
		$file->method('getSize')->willReturn($size ?? strlen($content));
		return $file;
	}

	/** @return Folder&MockObject */
	private function mockListingFolder(array $children): Folder {
		$folder = $this->createMock(Folder::class);
		$folder->method('getDirectoryListing')->willReturn(array_values($children));
		return $folder;
	}

	public function testIndexMergesOrgAndPersonalEntries(): void {
		$pointerContent = json_encode(['elements' => [], 'libraryRef' => ['scope' => 'org', 'name' => 'Kit']], JSON_THROW_ON_ERROR);

		$orgPointers = $this->mockListingFolder([
			$this->mockFile(11, 'Kit.whiteboard', $pointerContent),
		]);
		$orgCanvasTemplates = $this->mockListingFolder([
			$this->mockFile(22, 'Kanban.whiteboard', json_encode(['elements' => [[]]], JSON_THROW_ON_ERROR)),
		]);
		$userTemplates = $this->mockListingFolder([
			// Small pointer file -> library.
			$this->mockFile(33, 'My kit.whiteboard', json_encode(['elements' => [], 'libraryRef' => ['scope' => 'personal', 'name' => 'My kit']], JSON_THROW_ON_ERROR)),
			// Big file -> template, content never decoded.
			$this->mockFile(44, 'Big board.whiteboard', '{}', 10 * 1024 * 1024),
			// Small real board -> template.
			$this->mockFile(55, 'Small board.whiteboard', json_encode(['elements' => [[]]], JSON_THROW_ON_ERROR)),
			// Non-whiteboard files are ignored.
			$this->mockFile(66, 'notes.txt', 'hello'),
		]);

		$templateManager = $this->createMock(ITemplateManager::class);
		$templateManager->method('hasTemplateDirectory')->willReturn(true);
		$templateManager->method('getTemplatePath')->willReturn('Templates/');

		$userFolder = $this->createMock(Folder::class);
		$userFolder->method('get')->with('Templates/')->willReturn($userTemplates);

		$rootFolder = $this->createMock(IRootFolder::class);
		$rootFolder->method('getUserFolder')->with('alice')->willReturn($userFolder);
		$rootFolder->method('get')->willReturnCallback(static function (string $path) use ($orgPointers, $orgCanvasTemplates) {
			return match ($path) {
				'appdata_test/whiteboard/library-pointers' => $orgPointers,
				'appdata_test/whiteboard/templates' => $orgCanvasTemplates,
				default => throw new NotFoundException($path),
			};
		});

		$config = $this->createMock(IConfig::class);
		$config->method('getSystemValueString')->with('instanceid', '')->willReturn('test');

		$user = $this->createMock(IUser::class);
		$user->method('getUID')->willReturn('alice');
		$userSession = $this->createMock(IUserSession::class);
		$userSession->method('getUser')->willReturn($user);

		$logger = $this->createMock(LoggerInterface::class);
		$folders = new WhiteboardFolderService($templateManager, $rootFolder, $config, $logger);
		$controller = new PickerController(
			$this->createMock(IRequest::class),
			$userSession,
			new WhiteboardLibraryService($folders, $config, $logger),
			new CanvasTemplateService($folders, $logger),
			$folders,
			$logger,
		);

		$entries = $controller->index()->getData()['entries'];

		$this->assertSame(['kind' => 'library', 'scope' => 'org'], $entries['11']);
		$this->assertSame(['kind' => 'canvas-template', 'scope' => 'org'], $entries['22']);
		$this->assertSame(['kind' => 'library', 'scope' => 'personal'], $entries['33']);
		$this->assertSame(['kind' => 'canvas-template', 'scope' => 'personal'], $entries['44']);
		$this->assertSame(['kind' => 'canvas-template', 'scope' => 'personal'], $entries['55']);
		$this->assertArrayNotHasKey('66', $entries);
	}

	public function testIndexIsEmptyAndSafeWithoutSessionUserAndAppData(): void {
		$rootFolder = $this->createMock(IRootFolder::class);
		$rootFolder->method('get')->willReturnCallback(static fn (string $path) => throw new NotFoundException($path));

		$config = $this->createMock(IConfig::class);
		$config->method('getSystemValueString')->with('instanceid', '')->willReturn('test');

		$userSession = $this->createMock(IUserSession::class);
		$userSession->method('getUser')->willReturn(null);

		$logger = $this->createMock(LoggerInterface::class);
		$folders = new WhiteboardFolderService($this->createMock(ITemplateManager::class), $rootFolder, $config, $logger);
		$controller = new PickerController(
			$this->createMock(IRequest::class),
			$userSession,
			new WhiteboardLibraryService($folders, $config, $logger),
			new CanvasTemplateService($folders, $logger),
			$folders,
			$logger,
		);

		$this->assertSame([], $controller->index()->getData()['entries']);
	}
}
