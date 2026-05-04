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

class CanvasTemplateServiceTest extends TestCase {
	private const UID = 'alice';

	private CanvasTemplateService $service;

	/** Children of the user's Templates folder, name => node mock. */
	private array $templatesChildren = [];
	/** Children of appdata whiteboard/templates, name => node mock. */
	private array $orgCanvasTemplates = [];
	private bool $orgCanvasTemplatesDirExists = false;

	protected function setUp(): void {
		parent::setUp();

		$templateManager = $this->createMock(ITemplateManager::class);
		$templateManager->method('hasTemplateDirectory')->willReturn(true);
		$templateManager->method('getTemplatePath')->willReturn('Templates/');

		$templatesFolder = $this->mockFolder($this->templatesChildren);
		$userFolder = $this->createMock(Folder::class);
		$userFolder->method('get')->with('Templates/')->willReturn($templatesFolder);

		$orgCanvasTemplatesFolder = $this->mockFolder($this->orgCanvasTemplates);

		$whiteboardFolder = $this->createMock(Folder::class);
		$whiteboardFolder->method('nodeExists')->with('templates')->willReturnCallback(fn (): bool => $this->orgCanvasTemplatesDirExists);
		$whiteboardFolder->method('get')->with('templates')->willReturn($orgCanvasTemplatesFolder);
		$whiteboardFolder->method('newFolder')->willReturnCallback(function () use ($orgCanvasTemplatesFolder): Folder {
			$this->orgCanvasTemplatesDirExists = true;
			return $orgCanvasTemplatesFolder;
		});

		$appDataRoot = $this->createMock(Folder::class);
		$appDataRoot->method('nodeExists')->with('whiteboard')->willReturn(true);
		$appDataRoot->method('get')->with('whiteboard')->willReturn($whiteboardFolder);

		$rootFolder = $this->createMock(IRootFolder::class);
		$rootFolder->method('getUserFolder')->with(self::UID)->willReturn($userFolder);
		$rootFolder->method('nodeExists')->willReturnCallback(static fn (string $n): bool => $n === 'appdata_test');
		$rootFolder->method('get')->willReturnCallback(function (string $path) use ($appDataRoot, $orgCanvasTemplatesFolder) {
			if ($path === 'appdata_test') {
				return $appDataRoot;
			}
			if ($path === 'appdata_test/whiteboard/templates' && $this->orgCanvasTemplatesDirExists) {
				return $orgCanvasTemplatesFolder;
			}
			throw new \OCP\Files\NotFoundException($path);
		});

		$config = $this->createMock(IConfig::class);
		$config->method('getSystemValueString')->with('instanceid', '')->willReturn('test');

		$logger = $this->createMock(LoggerInterface::class);
		$folders = new WhiteboardFolderService($templateManager, $rootFolder, $config, $logger, static fn (): bool => true);
		$this->service = new CanvasTemplateService($folders, $logger);
	}

	/** @return Folder&MockObject */
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
		return $folder;
	}

	/** @return File&MockObject */
	private function mockWritableFile(string $name, string $content = ''): File {
		$state = new \stdClass();
		$state->content = $content;
		$file = $this->createMock(File::class);
		$file->method('getName')->willReturn($name);
		$file->method('getSize')->willReturnCallback(static fn (): int => strlen($state->content));
		$file->method('putContent')->willReturnCallback(static function ($newContent) use ($state): void {
			$state->content = $newContent;
		});
		$file->method('getContent')->willReturnCallback(static fn (): string => $state->content);
		return $file;
	}

	// -------------------------------------------------------------------
	// parseCanvasTemplateData
	// -------------------------------------------------------------------

	public function testParseCanvasTemplateDataCanonicalizesBoard(): void {
		$data = $this->service->parseCanvasTemplateData([
			'elements' => [['type' => 'rectangle'], 'not-an-element'],
			'files' => ['f1' => ['mimeType' => 'image/png'], 'f2' => null],
			'appState' => ['viewBackgroundColor' => '#fff', 'collaborators' => ['x'], 'selectedElementIds' => ['y']],
			'libraryRef' => ['scope' => 'personal', 'name' => 'Kit'],
			'scrollToContent' => false,
		]);

		$this->assertSame([['type' => 'rectangle']], $data['elements']);
		$this->assertSame(['f1' => ['mimeType' => 'image/png']], $data['files']);
		$this->assertTrue($data['scrollToContent']);
		$this->assertSame(['viewBackgroundColor' => '#fff'], $data['appState']);
		$this->assertArrayNotHasKey('libraryRef', $data);
	}

	public function testParseCanvasTemplateDataAcceptsJsonString(): void {
		$data = $this->service->parseCanvasTemplateData(json_encode(['elements' => [['type' => 'ellipse']]], JSON_THROW_ON_ERROR));
		$this->assertCount(1, $data['elements']);
	}

	public function testParseCanvasTemplateDataRejectsEmptyElements(): void {
		$this->expectException(InvalidArgumentException::class);
		$this->service->parseCanvasTemplateData(['elements' => []]);
	}

	public function testParseCanvasTemplateDataRejectsInvalidJson(): void {
		$this->expectException(InvalidArgumentException::class);
		$this->service->parseCanvasTemplateData('not json');
	}

	public function testParseCanvasTemplateDataRejectsOversizedPayload(): void {
		$this->expectException(InvalidArgumentException::class);
		$this->expectExceptionMessage('too large');
		$this->service->parseCanvasTemplateData(str_repeat('x', CanvasTemplateService::MAX_CANVAS_TEMPLATE_BYTES + 1));
	}

	// -------------------------------------------------------------------
	// publishCanvasTemplate
	// -------------------------------------------------------------------

	public function testPublishTemplatePersonalWritesIntoTemplatesFolder(): void {
		$result = $this->service->publishCanvasTemplate(self::UID, 'personal', 'Retro board', [
			'elements' => [['type' => 'rectangle']],
			'files' => [],
			'scrollToContent' => true,
		]);

		$this->assertSame(['name' => 'Retro board', 'scope' => 'personal'], $result);
		$content = json_decode($this->templatesChildren['Retro board.whiteboard']->getContent(), true);
		$this->assertSame([['type' => 'rectangle']], $content['elements']);
	}

	public function testPublishTemplateOrgWritesIntoAppData(): void {
		$this->service->publishCanvasTemplate(self::UID, 'org', 'Kanban', [
			'elements' => [['type' => 'rectangle']],
			'files' => [],
			'scrollToContent' => true,
		]);

		$this->assertArrayHasKey('Kanban.whiteboard', $this->orgCanvasTemplates);
	}

	public function testPublishTemplateRejectsInvalidScope(): void {
		$this->expectException(InvalidArgumentException::class);
		$this->service->publishCanvasTemplate(self::UID, 'global', 'Name', ['elements' => [[]]]);
	}

	public function testPublishTemplateConflictsWithLibraryPointerOfSameName(): void {
		$pointerJson = json_encode([
			'elements' => [],
			'files' => [],
			'scrollToContent' => true,
			'libraryRef' => ['scope' => 'personal', 'name' => 'Kit'],
		], JSON_THROW_ON_ERROR);
		$this->templatesChildren['Kit.whiteboard'] = $this->mockWritableFile('Kit.whiteboard', $pointerJson);

		try {
			$this->service->publishCanvasTemplate(self::UID, 'personal', 'Kit', [
				'elements' => [['type' => 'rectangle']],
				'files' => [],
				'scrollToContent' => true,
			]);
			$this->fail('Expected a conflict');
		} catch (InvalidArgumentException $e) {
			$this->assertSame(\OCP\AppFramework\Http::STATUS_CONFLICT, $e->getCode());
		}

		// The library pointer was not touched.
		$this->assertSame($pointerJson, $this->templatesChildren['Kit.whiteboard']->getContent());
	}

	public function testPublishTemplateOverwritesExistingCanvasTemplate(): void {
		$this->templatesChildren['Retro board.whiteboard'] = $this->mockWritableFile(
			'Retro board.whiteboard',
			json_encode(['elements' => [['type' => 'ellipse']], 'files' => []], JSON_THROW_ON_ERROR)
		);

		$this->service->publishCanvasTemplate(self::UID, 'personal', 'Retro board', [
			'elements' => [['type' => 'rectangle']],
			'files' => [],
			'scrollToContent' => true,
		]);

		$content = json_decode($this->templatesChildren['Retro board.whiteboard']->getContent(), true);
		$this->assertSame([['type' => 'rectangle']], $content['elements']);
	}

	// -------------------------------------------------------------------
	// listOrgCanvasTemplates / deleteOrgCanvasTemplate
	// -------------------------------------------------------------------

	public function testListOrgTemplatesSortedWithElementCounts(): void {
		$this->orgCanvasTemplatesDirExists = true;
		$this->orgCanvasTemplates['zebra.whiteboard'] = $this->mockWritableFile('zebra.whiteboard', json_encode(['elements' => [[], []]], JSON_THROW_ON_ERROR));
		$this->orgCanvasTemplates['Alpha.whiteboard'] = $this->mockWritableFile('Alpha.whiteboard', json_encode(['elements' => [[]]], JSON_THROW_ON_ERROR));
		$this->orgCanvasTemplates['broken.whiteboard'] = $this->mockWritableFile('broken.whiteboard', 'not json');

		$templates = $this->service->listOrgCanvasTemplates();

		$this->assertSame(['Alpha', 'broken', 'zebra'], array_column($templates, 'name'));
		$this->assertSame([1, 0, 2], array_column($templates, 'elementCount'));
	}

	public function testListOrgTemplatesEmptyWhenFolderMissing(): void {
		$this->assertSame([], $this->service->listOrgCanvasTemplates());
	}

	public function testDeleteOrgTemplateRemovesFile(): void {
		$this->orgCanvasTemplatesDirExists = true;
		$file = $this->mockWritableFile('Kanban.whiteboard', '{}');
		$file->expects($this->once())->method('delete');
		$this->orgCanvasTemplates['Kanban.whiteboard'] = $file;

		$this->service->deleteOrgCanvasTemplate('Kanban');
	}

	public function testTemplateNameFromFileStripsExtension(): void {
		$this->assertSame('Kanban', $this->service->canvasTemplateNameFromFile('Kanban.whiteboard'));
		$this->assertSame('plain.txt', $this->service->canvasTemplateNameFromFile('plain.txt'));
	}
}
