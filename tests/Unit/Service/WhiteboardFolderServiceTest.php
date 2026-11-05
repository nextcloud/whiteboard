<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use InvalidArgumentException;
use OCA\Whiteboard\Exception\TemplatesFolderUnavailableException;
use OCP\AppFramework\Http;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\IUserFolder;
use OCP\Files\NotFoundException;
use OCP\Files\Template\ITemplateManager;
use OCP\IConfig;
use OCP\IL10N;
use OCP\L10N\IFactory;
use OCP\Lock\LockedException;
use PHPUnit\Framework\Attributes\DataProvider;
use Psr\Log\LoggerInterface;
use Test\TestCase;

class WhiteboardFolderServiceTest extends TestCase {
	private WhiteboardFolderService $service;

	protected function setUp(): void {
		parent::setUp();
		$this->service = new WhiteboardFolderService(
			$this->createMock(ITemplateManager::class),
			$this->createMock(IRootFolder::class),
			$this->createMock(IConfig::class),
			$this->createMock(LoggerInterface::class),
			$this->createMock(IFactory::class),
		);
	}

	public function testNormalizeScopeAcceptsKnownScopes(): void {
		$this->assertSame('personal', $this->service->normalizeScope('personal'));
		$this->assertSame('org', $this->service->normalizeScope('org'));
	}

	public function testNormalizeScopeRejectsUnknownScope(): void {
		$this->expectException(InvalidArgumentException::class);
		$this->service->normalizeScope('global');
	}

	public function testNormalizeNameTrimsWhitespace(): void {
		$this->assertSame('My shapes', $this->service->normalizeName('  My shapes  '));
	}

	#[DataProvider('invalidNameProvider')]
	public function testNormalizeNameRejectsInvalidNames(string $name): void {
		$this->expectException(InvalidArgumentException::class);
		$this->service->normalizeName($name);
	}

	public static function invalidNameProvider(): array {
		return [
			'empty' => [''],
			'whitespace only' => ['   '],
			'dot' => ['.'],
			'dot dot' => ['..'],
			'slash' => ['a/b'],
			'backslash' => ['a\\b'],
			'control char' => ["a\x01b"],
			'too long' => [str_repeat('x', 251)],
			'windows reserved' => ['CON'],
			'windows reserved lowercase' => ['nul'],
			'windows reserved with extension' => ['com1.board'],
		];
	}

	public function testIsValidNameMatchesNormalizeName(): void {
		$this->assertTrue(WhiteboardFolderService::isValidName('My shapes'));
		$this->assertTrue(WhiteboardFolderService::isValidName('console'));
		$this->assertFalse(WhiteboardFolderService::isValidName('CON'));
		$this->assertFalse(WhiteboardFolderService::isValidName(''));
		$this->assertFalse(WhiteboardFolderService::isValidName('a/b'));
		$this->assertFalse(WhiteboardFolderService::isValidName(' padded '));
		$this->assertFalse(WhiteboardFolderService::isValidName(str_repeat('x', 251)));
	}

	public static function missingTemplatesFolderProvider(): array {
		return [
			'no Templates folder set up' => [''],
			'root folder as Templates folder' => ['/'],
			'Templates folder deleted' => ['Old templates/'],
		];
	}

	#[DataProvider('missingTemplatesFolderProvider')]
	public function testCreatesTemplatesFolderInsteadOfUsingRootFolder(string $templatePath): void {
		$templates = $this->folder('/alice/files/Templates');
		$userFolder = $this->userFolder(['Templates/' => $templates]);

		$templateManager = $this->createMock(ITemplateManager::class);
		$templateManager->method('hasTemplateDirectory')->willReturn(true);
		$templateManager->method('getTemplatePath')->willReturn($templatePath);
		$templateManager->expects($this->once())
			->method('initializeTemplateDirectory')
			->with('Templates/', 'alice', false)
			->willReturn('Templates/');

		$this->assertSame($templates, $this->createService($templateManager, $userFolder)->getUserTemplateFolder('alice'));
	}

	public static function templatePathProvider(): array {
		return [
			'Templates folder created now' => [''],
			'Templates folder created earlier, move failed then' => ['Templates/'],
		];
	}

	#[DataProvider('templatePathProvider')]
	public function testMovesLibraryStoredInRootFolderIntoTemplatesFolder(string $templatePath): void {
		$templates = $this->folder('/alice/files/Templates');
		$library = $this->createMock(File::class);
		$library->expects($this->once())->method('move')->with('/alice/files/Templates/personal.excalidrawlib');
		$userFolder = $this->userFolder(['Templates/' => $templates, 'personal.excalidrawlib' => $library]);

		$this->assertSame($templates, $this->createService($this->templateManager($templatePath), $userFolder)->getUserTemplateFolder('alice'));
	}

	public function testKeepsWorkingWhenTheLibraryCannotBeMoved(): void {
		$templates = $this->folder('/alice/files/Templates');
		$library = $this->createStub(File::class);
		$library->method('move')->willThrowException(new LockedException('personal.excalidrawlib'));
		$userFolder = $this->userFolder(['Templates/' => $templates, 'personal.excalidrawlib' => $library]);

		$this->assertSame($templates, $this->createService($this->templateManager('Templates/'), $userFolder)->getUserTemplateFolder('alice'));
	}

	public function testUsesExistingTemplatesFolder(): void {
		$templates = $this->folder('/alice/files/Vorlagen');
		$userFolder = $this->userFolder(['Vorlagen/' => $templates]);

		$templateManager = $this->createMock(ITemplateManager::class);
		$templateManager->method('hasTemplateDirectory')->willReturn(true);
		$templateManager->method('getTemplatePath')->willReturn('Vorlagen/');
		$templateManager->expects($this->never())->method('initializeTemplateDirectory');

		$this->assertSame($templates, $this->createService($templateManager, $userFolder)->getUserTemplateFolder('alice'));
	}

	public function testFailsWhenNoTemplatesFolderCanBeCreated(): void {
		$this->expectException(TemplatesFolderUnavailableException::class);
		$this->expectExceptionCode(Http::STATUS_FAILED_DEPENDENCY);
		$this->expectExceptionMessage('alice');
		$this->createService($this->templateManager('', ''), $this->userFolder([]))->getUserTemplateFolder('alice');
	}

	private function folder(string $path): Folder {
		$folder = $this->createStub(Folder::class);
		$folder->method('getPath')->willReturn($path);
		$folder->method('nodeExists')->willReturn(false);
		return $folder;
	}

	/**
	 * @param array<string, Folder|File> $children
	 */
	private function userFolder(array $children): IUserFolder {
		$userFolder = $this->createStub(IUserFolder::class);
		$userFolder->method('getPath')->willReturn('/alice/files');
		$userFolder->method('nodeExists')->willReturnCallback(static fn (string $path) => isset($children[$path]));
		$userFolder->method('get')->willReturnCallback(static fn (string $path) => match (true) {
			$path === '' || $path === '/' => $userFolder,
			isset($children[$path]) => $children[$path],
			default => throw new NotFoundException($path),
		});
		return $userFolder;
	}

	private function templateManager(string $templatePath, string $initializedPath = 'Templates/'): ITemplateManager {
		$templateManager = $this->createStub(ITemplateManager::class);
		$templateManager->method('hasTemplateDirectory')->willReturn(true);
		$templateManager->method('getTemplatePath')->willReturn($templatePath);
		$templateManager->method('initializeTemplateDirectory')->willReturn($initializedPath);
		return $templateManager;
	}

	private function createService(ITemplateManager $templateManager, IUserFolder $userFolder): WhiteboardFolderService {
		$rootFolder = $this->createStub(IRootFolder::class);
		$rootFolder->method('getUserFolder')->willReturn($userFolder);
		$config = $this->createStub(IConfig::class);
		$config->method('getAppValue')->willReturnCallback(static fn (string $app, string $key, string $default) => $default);
		$l10n = $this->createStub(IL10N::class);
		$l10n->method('t')->willReturnArgument(0);
		$l10nFactory = $this->createStub(IFactory::class);
		$l10nFactory->method('get')->willReturn($l10n);

		return new WhiteboardFolderService($templateManager, $rootFolder, $config, $this->createStub(LoggerInterface::class), $l10nFactory);
	}
}
