<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use InvalidArgumentException;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\Template\ITemplateManager;
use OCP\IConfig;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;
use Test\TestCase;

class WhiteboardLibraryServiceTest extends TestCase {
	private const UID = 'alice';

	/** @var ITemplateManager&MockObject */
	private $templateManager;
	/** @var IRootFolder&MockObject */
	private $rootFolder;
	private WhiteboardLibraryService $service;

	/** Children of the user's Templates folder, name => node mock. */
	private array $templatesChildren = [];
	/** Children of appdata whiteboard/<dir>, dir => [name => node mock]. */
	private array $appDataChildren = [];

	protected function setUp(): void {
		parent::setUp();

		$this->templateManager = $this->createMock(ITemplateManager::class);
		$this->templateManager->method('hasTemplateDirectory')->willReturn(true);
		$this->templateManager->method('getTemplatePath')->willReturn('Templates/');

		$templatesFolder = $this->mockFolder($this->templatesChildren);
		$userFolder = $this->createMock(Folder::class);
		$userFolder->method('get')->with('Templates/')->willReturn($templatesFolder);

		// App data tree: appdata_test/whiteboard/<dir>. Lazily materialized
		// folder mocks share their children arrays with $this->appDataChildren,
		// so tests can seed files before a call and inspect writes after it.
		$appDataDirs = [];
		$makeDir = function (string $dir) use (&$appDataDirs): Folder {
			if (!isset($appDataDirs[$dir])) {
				if (!isset($this->appDataChildren[$dir])) {
					$this->appDataChildren[$dir] = [];
				}
				$appDataDirs[$dir] = $this->mockFolder($this->appDataChildren[$dir]);
			}
			return $appDataDirs[$dir];
		};

		$whiteboardFolder = $this->createMock(Folder::class);
		$whiteboardFolder->method('nodeExists')->willReturnCallback(fn (string $dir): bool => isset($this->appDataChildren[$dir]));
		$whiteboardFolder->method('get')->willReturnCallback($makeDir);
		$whiteboardFolder->method('newFolder')->willReturnCallback($makeDir);

		$appDataRoot = $this->createMock(Folder::class);
		$appDataRoot->method('nodeExists')->with('whiteboard')->willReturn(true);
		$appDataRoot->method('get')->with('whiteboard')->willReturn($whiteboardFolder);

		$this->rootFolder = $this->createMock(IRootFolder::class);
		$this->rootFolder->method('getUserFolder')->with(self::UID)->willReturn($userFolder);
		$this->rootFolder->method('nodeExists')->willReturnCallback(static fn (string $n): bool => $n === 'appdata_test');
		$this->rootFolder->method('get')->willReturnCallback(function (string $path) use ($appDataRoot, $makeDir) {
			if ($path === 'appdata_test') {
				return $appDataRoot;
			}
			if (preg_match('#^appdata_test/whiteboard/(.+)$#', $path, $m) === 1 && isset($this->appDataChildren[$m[1]])) {
				return $makeDir($m[1]);
			}
			throw new \OCP\Files\NotFoundException($path);
		});

		$config = $this->createMock(IConfig::class);
		$config->method('getSystemValueString')->with('instanceid', '')->willReturn('test');

		$logger = $this->createMock(LoggerInterface::class);
		$folders = new WhiteboardFolderService($this->templateManager, $this->rootFolder, $config, $logger, static fn (): bool => true);
		$this->service = new WhiteboardLibraryService($folders, $config, $logger);
	}

	// -------------------------------------------------------------------
	// helpers
	// -------------------------------------------------------------------

	/**
	 * Folder mock backed by a by-reference children array. newFile() and
	 * newFolder() mutate it, so created nodes are visible to later calls.
	 *
	 * @return Folder&MockObject
	 */
	private function mockFolder(array &$children): Folder {
		$folder = $this->createMock(Folder::class);
		$folder->method('nodeExists')->willReturnCallback(static function (string $name) use (&$children): bool {
			return isset($children[$name]);
		});
		$folder->method('get')->willReturnCallback(static function (string $name) use (&$children) {
			if (!isset($children[$name])) {
				throw new \OCP\Files\NotFoundException($name);
			}
			return $children[$name];
		});
		$folder->method('getDirectoryListing')->willReturnCallback(static function () use (&$children): array {
			return array_values($children);
		});
		$folder->method('newFile')->willReturnCallback(function (string $name) use (&$children) {
			$children[$name] = $this->mockWritableFile($name);
			return $children[$name];
		});
		$folder->method('newFolder')->willReturnCallback(function (string $name) use (&$children) {
			$grandChildren = [];
			$children[$name] = $this->mockFolder($grandChildren);
			return $children[$name];
		});
		return $folder;
	}

	/** @return File&MockObject */
	private function mockWritableFile(string $name, string $content = ''): File {
		$state = new \stdClass();
		$state->content = $content;
		$file = $this->createMock(File::class);
		$file->method('getName')->willReturn($name);
		$file->method('putContent')->willReturnCallback(static function ($newContent) use ($state): void {
			$state->content = $newContent;
		});
		$file->method('getContent')->willReturnCallback(static fn (): string => $state->content);
		return $file;
	}

	private function libraryJson(array $items): string {
		return json_encode(['type' => 'excalidrawlib', 'version' => 2, 'libraryItems' => $items], JSON_THROW_ON_ERROR);
	}

	private function pointerJson(string $scope, string $name): string {
		return json_encode([
			'elements' => [],
			'files' => [],
			'scrollToContent' => true,
			'libraryRef' => ['scope' => $scope, 'name' => $name],
		], JSON_THROW_ON_ERROR);
	}

	// -------------------------------------------------------------------
	// saveLibrary
	// -------------------------------------------------------------------

	public function testSaveLibraryPersonalWritesItemsAndPointer(): void {
		$result = $this->service->saveLibrary(self::UID, 'personal', ' My shapes ', [
			['elements' => [['type' => 'rectangle']], 'libraryName' => 'stale-tag'],
		]);

		$this->assertSame(['name' => 'My shapes', 'scope' => 'personal'], $result);

		$libraryDir = $this->templatesChildren['.whiteboard-libraries'];
		$itemsFile = $libraryDir->get('My shapes.excalidrawlib');
		$items = json_decode($itemsFile->getContent(), true)['libraryItems'];
		$this->assertCount(1, $items);
		$this->assertArrayNotHasKey('libraryName', $items[0]);

		$pointer = json_decode($this->templatesChildren['My shapes.whiteboard']->getContent(), true);
		$this->assertSame(['scope' => 'personal', 'name' => 'My shapes'], $pointer['libraryRef']);
		$this->assertSame([], $pointer['elements']);
	}

	public function testSaveLibraryOrgWritesToAppData(): void {
		$this->service->saveLibrary(self::UID, 'org', 'Brand kit', [
			['elements' => [['type' => 'ellipse']]],
		]);

		$this->assertArrayHasKey('Brand kit.excalidrawlib', $this->appDataChildren['libraries']);
		$pointer = json_decode($this->appDataChildren['library-pointers']['Brand kit.whiteboard']->getContent(), true);
		$this->assertSame(['scope' => 'org', 'name' => 'Brand kit'], $pointer['libraryRef']);
	}

	public function testSaveLibraryRejectsEmptyItems(): void {
		$this->expectException(InvalidArgumentException::class);
		$this->service->saveLibrary(self::UID, 'personal', 'Empty', [
			['elements' => []],
			'not-an-item',
		]);
	}

	public function testSaveLibraryRejectsInvalidScope(): void {
		$this->expectException(InvalidArgumentException::class);
		$this->service->saveLibrary(self::UID, 'global', 'Name', [['elements' => [['type' => 'rectangle']]]]);
	}

	public function testSaveLibraryRejectsImageItems(): void {
		$this->expectException(InvalidArgumentException::class);
		$this->expectExceptionMessage('image items');
		$this->service->saveLibrary(self::UID, 'personal', 'Pics', [
			['elements' => [['type' => 'rectangle'], ['type' => 'image']]],
		]);
	}

	public function testSaveLibraryConflictsWithCanvasTemplateOfSameName(): void {
		$this->templatesChildren['Kit.whiteboard'] = $this->mockWritableFile(
			'Kit.whiteboard',
			json_encode(['elements' => [['type' => 'rectangle']], 'files' => []], JSON_THROW_ON_ERROR)
		);

		try {
			$this->service->saveLibrary(self::UID, 'personal', 'Kit', [['elements' => [['type' => 'ellipse']]]]);
			$this->fail('Expected a conflict');
		} catch (InvalidArgumentException $e) {
			$this->assertSame(\OCP\AppFramework\Http::STATUS_CONFLICT, $e->getCode());
		}

		// The conflict is detected before the items file is written — no orphan.
		$this->assertArrayNotHasKey('.whiteboard-libraries', $this->templatesChildren);
		// The canvas template was not touched.
		$content = json_decode($this->templatesChildren['Kit.whiteboard']->getContent(), true);
		$this->assertSame([['type' => 'rectangle']], $content['elements']);
	}

	public function testSaveLibraryOverwritesExistingPointer(): void {
		$this->templatesChildren['Kit.whiteboard'] = $this->mockWritableFile('Kit.whiteboard', $this->pointerJson('personal', 'Kit'));

		$result = $this->service->saveLibrary(self::UID, 'personal', 'Kit', [['elements' => [['type' => 'ellipse']]]]);

		$this->assertSame(['name' => 'Kit', 'scope' => 'personal'], $result);
		$pointer = json_decode($this->templatesChildren['Kit.whiteboard']->getContent(), true);
		$this->assertSame(['scope' => 'personal', 'name' => 'Kit'], $pointer['libraryRef']);
	}

	// -------------------------------------------------------------------
	// listLibraries / resolveLibrary
	// -------------------------------------------------------------------

	public function testListLibrariesReturnsBothScopesSorted(): void {
		$personalChildren = [];
		$personalDir = $this->mockFolder($personalChildren);
		$personalChildren['zebra.excalidrawlib'] = $this->mockWritableFile('zebra.excalidrawlib', $this->libraryJson([['elements' => [[]]]]));
		$personalChildren['Alpha.excalidrawlib'] = $this->mockWritableFile('Alpha.excalidrawlib', $this->libraryJson([['elements' => [[]]], ['elements' => [[]]]]));
		$personalChildren['broken.excalidrawlib'] = $this->mockWritableFile('broken.excalidrawlib', 'not json');
		$this->templatesChildren['.whiteboard-libraries'] = $personalDir;

		$this->appDataChildren['libraries'] = [
			'Org kit.excalidrawlib' => $this->mockWritableFile('Org kit.excalidrawlib', $this->libraryJson([['elements' => [[]]]])),
		];

		$result = $this->service->listLibraries(self::UID);

		$this->assertSame(
			[['name' => 'Alpha', 'itemCount' => 2], ['name' => 'broken', 'itemCount' => 0], ['name' => 'zebra', 'itemCount' => 1]],
			$result['personal']
		);
		$this->assertSame([['name' => 'Org kit', 'itemCount' => 1]], $result['org']);
	}

	public function testResolveLibraryTagsItemsWithLibraryName(): void {
		$personalChildren = [];
		$personalDir = $this->mockFolder($personalChildren);
		$personalChildren['Kit.excalidrawlib'] = $this->mockWritableFile('Kit.excalidrawlib', $this->libraryJson([
			['id' => 'src1', 'elements' => [['type' => 'rectangle']], 'filename' => 'x', 'writable' => true],
		]));
		$this->templatesChildren['.whiteboard-libraries'] = $personalDir;

		$items = $this->service->resolveLibrary(self::UID, 'personal', 'Kit');

		$this->assertCount(1, $items);
		$this->assertSame('Kit', $items[0]['libraryName']);
		// Namespaced so resolved items never collide with their "My library" originals.
		$this->assertSame('personal:Kit:src1', $items[0]['id']);
		$this->assertArrayNotHasKey('filename', $items[0]);
		$this->assertArrayNotHasKey('writable', $items[0]);
	}

	public function testResolveLibraryReturnsEmptyWhenMissing(): void {
		$this->assertSame([], $this->service->resolveLibrary(self::UID, 'org', 'Nope'));
		$this->assertSame([], $this->service->resolveLibrary(self::UID, 'personal', 'Nope'));
	}

	public function testListLibrariesEmptyWithoutAnyFolders(): void {
		$this->assertSame(['personal' => [], 'org' => []], $this->service->listLibraries(self::UID));
	}

	public function testListLibrariesBlocksSharedSessionsFromOrg(): void {
		$this->appDataChildren['libraries'] = [
			'Org kit.excalidrawlib' => $this->mockWritableFile('Org kit.excalidrawlib', $this->libraryJson([['elements' => [[]]]])),
		];

		$this->assertSame(['personal' => [], 'org' => []], $this->service->listLibraries('shared_token123'));
	}

	public function testResolveLibraryBlocksSharedSessionsFromOrg(): void {
		$this->appDataChildren['libraries'] = [
			'Org kit.excalidrawlib' => $this->mockWritableFile('Org kit.excalidrawlib', $this->libraryJson([['elements' => [['type' => 'rectangle']]]])),
		];

		$this->assertSame([], $this->service->resolveLibrary('shared_token123', 'org', 'Org kit'));
	}

	// -------------------------------------------------------------------
	// deleteLibrary
	// -------------------------------------------------------------------

	public function testDeleteLibraryRemovesItemsAndPointer(): void {
		$personalChildren = [];
		$personalDir = $this->mockFolder($personalChildren);
		$itemsFile = $this->mockWritableFile('Kit.excalidrawlib', $this->libraryJson([['elements' => [[]]]]));
		$itemsFile->expects($this->once())->method('delete');
		$personalChildren['Kit.excalidrawlib'] = $itemsFile;
		$this->templatesChildren['.whiteboard-libraries'] = $personalDir;

		$pointer = $this->mockWritableFile('Kit.whiteboard', $this->pointerJson('personal', 'Kit'));
		$pointer->expects($this->once())->method('delete');
		$this->templatesChildren['Kit.whiteboard'] = $pointer;

		$this->service->deleteLibrary(self::UID, 'personal', 'Kit');
	}

	public function testDeleteLibraryKeepsCanvasTemplateOfSameName(): void {
		$canvasTemplate = $this->mockWritableFile(
			'Kit.whiteboard',
			json_encode(['elements' => [['type' => 'rectangle']], 'files' => []], JSON_THROW_ON_ERROR)
		);
		$canvasTemplate->expects($this->never())->method('delete');
		$this->templatesChildren['Kit.whiteboard'] = $canvasTemplate;

		$this->service->deleteLibrary(self::UID, 'personal', 'Kit');
	}

	// -------------------------------------------------------------------
	// parseLibraryFile
	// -------------------------------------------------------------------

	public function testParseLibraryFileReadsV2(): void {
		$items = $this->service->parseLibraryFile($this->libraryJson([['elements' => [['type' => 'rectangle']]]]));
		$this->assertCount(1, $items);
	}

	public function testParseLibraryFileReadsV1(): void {
		$content = json_encode(['type' => 'excalidrawlib', 'version' => 1, 'library' => [[['type' => 'rectangle']]]], JSON_THROW_ON_ERROR);
		$items = $this->service->parseLibraryFile($content);
		$this->assertCount(1, $items);
		$this->assertSame([['type' => 'rectangle']], $items[0]['elements']);
	}

	public function testParseLibraryFileRejectsInvalidJson(): void {
		$this->expectException(InvalidArgumentException::class);
		$this->service->parseLibraryFile('not json');
	}

	public function testParseLibraryFileRejectsEmptyLibrary(): void {
		$this->expectException(InvalidArgumentException::class);
		$this->service->parseLibraryFile($this->libraryJson([]));
	}

	public function testParseLibraryFileRejectsImageItems(): void {
		$this->expectException(InvalidArgumentException::class);
		$this->expectExceptionMessage('image items');
		$this->service->parseLibraryFile($this->libraryJson([
			['elements' => [['type' => 'image']]],
		]));
	}

	// -------------------------------------------------------------------
	// pointer helpers
	// -------------------------------------------------------------------

	public function testLibraryNameFromPointerStripsExtension(): void {
		$this->assertSame('Kit', $this->service->libraryNameFromPointer('Kit.whiteboard'));
		$this->assertSame('other.txt', $this->service->libraryNameFromPointer('other.txt'));
	}

	public function testGetOrgLibraryPointerFilesListsOnlyWhiteboardFiles(): void {
		$this->appDataChildren['library-pointers'] = [
			'Kit.whiteboard' => $this->mockWritableFile('Kit.whiteboard'),
			'readme.txt' => $this->mockWritableFile('readme.txt'),
		];

		$files = $this->service->getOrgLibraryPointerFiles();
		$this->assertCount(1, $files);
		$this->assertSame('Kit.whiteboard', $files[0]->getName());
	}
}
