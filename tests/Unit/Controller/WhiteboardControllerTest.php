<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Controller;

use Firebase\JWT\JWT;
use OCA\Whiteboard\Consts\JWTConsts;
use OCA\Whiteboard\Service\Authentication\GetUserFromIdServiceFactory;
use OCA\Whiteboard\Service\CanvasTemplateService;
use OCA\Whiteboard\Service\ConfigService;
use OCA\Whiteboard\Service\ExceptionService;
use OCA\Whiteboard\Service\File\GetFileServiceFactory;
use OCA\Whiteboard\Service\JWTService;
use OCA\Whiteboard\Service\WhiteboardContentService;
use OCA\Whiteboard\Service\WhiteboardFolderService;
use OCA\Whiteboard\Service\WhiteboardLibraryService;
use OCP\AppFramework\Http;
use OCP\AppFramework\Services\IAppConfig;
use OCP\Constants;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\Template\ITemplateManager;
use OCP\ICacheFactory;
use OCP\IConfig;
use OCP\IGroupManager;
use OCP\IMemcache;
use OCP\IRequest;
use OCP\IUser;
use OCP\IUserManager;
use OCP\IUserSession;
use OCP\Share\IManager as ShareManager;
use Psr\Log\LoggerInterface;
use Test\TestCase;

class WhiteboardControllerTest extends TestCase {
	private const SECRET = 'test-secret-at-least-32-bytes-long';
	private const UID = 'bob';

	/** Captured writes into the user's Templates folder, name => File mock. */
	private array $templatesChildren = [];

	private function makeController(
		bool $isAdmin,
		array $params,
		int $whiteboardFilePermissions = Constants::PERMISSION_READ | Constants::PERMISSION_UPDATE,
	): WhiteboardController {
		$request = $this->createMock(IRequest::class);
		$jwt = JWT::encode(['userid' => self::UID, 'exp' => time() + 300], self::SECRET, JWTConsts::JWT_ALGORITHM);
		$request->method('getHeader')->willReturnCallback(static fn (string $name): string => $name === 'Authorization' ? 'Bearer ' . $jwt : '');
		$request->method('getParam')->willReturnCallback(static fn (string $key, $default = null) => $params[$key] ?? $default);

		$appConfig = $this->createMock(IAppConfig::class);
		$appConfig->method('getAppValueString')->willReturn(self::SECRET);
		$configService = new ConfigService($appConfig, $this->createMock(IConfig::class));

		$templateManager = $this->createMock(ITemplateManager::class);
		$templateManager->method('hasTemplateDirectory')->willReturn(true);
		$templateManager->method('getTemplatePath')->willReturn('Templates/');

		$templatesFolder = $this->createMock(Folder::class);
		$templatesFolder->method('nodeExists')->willReturnCallback(fn (string $name): bool => isset($this->templatesChildren[$name]));
		$templatesFolder->method('get')->willReturnCallback(fn (string $name) => $this->templatesChildren[$name]);
		$templatesFolder->method('newFile')->willReturnCallback(function (string $name) {
			$file = $this->createMock(File::class);
			$file->method('getName')->willReturn($name);
			$file->method('getContent')->willReturn('');
			$this->templatesChildren[$name] = $file;
			return $file;
		});
		$templatesFolder->method('newFolder')->willReturnCallback(function (string $name) {
			$folder = $this->createMock(Folder::class);
			$folder->method('newFile')->willReturnCallback(function (string $fileName) {
				$file = $this->createMock(File::class);
				$file->method('getName')->willReturn($fileName);
				return $file;
			});
			$this->templatesChildren[$name] = $folder;
			return $folder;
		});

		$userFolder = $this->createMock(Folder::class);
		$userFolder->method('get')->with('Templates/')->willReturn($templatesFolder);
		$whiteboardFile = $this->createMock(File::class);
		$whiteboardFile->method('getId')->willReturn(123);
		$whiteboardFile->method('getPermissions')->willReturn($whiteboardFilePermissions);
		$whiteboardFile->method('getContent')->willReturn('{"elements":[],"files":[]}');
		$userFolder->method('getFirstNodeById')->willReturn($whiteboardFile);
		$userFolder->method('getById')->willReturn([$whiteboardFile]);

		$rootFolder = $this->createMock(IRootFolder::class);
		$rootFolder->method('getUserFolder')->with(self::UID)->willReturn($userFolder);

		$config = $this->createMock(IConfig::class);
		$config->method('getSystemValueString')->with('instanceid', '')->willReturn('test');

		$logger = $this->createMock(LoggerInterface::class);
		$folders = new WhiteboardFolderService($templateManager, $rootFolder, $config, $logger, static fn (): bool => true);

		$cache = $this->createMock(IMemcache::class);
		$cache->method('add')->willReturn(true);
		$cacheFactory = $this->createMock(ICacheFactory::class);
		$cacheFactory->method('createLocking')->willReturn($cache);

		$groupManager = $this->createMock(IGroupManager::class);
		$groupManager->method('isAdmin')->with(self::UID)->willReturn($isAdmin);
		$user = $this->createMock(IUser::class);
		$user->method('getUID')->willReturn(self::UID);
		$user->method('getDisplayName')->willReturn('Bob');
		$userManager = $this->createMock(IUserManager::class);
		$userManager->method('get')->with(self::UID)->willReturn($user);
		$userSession = $this->createMock(IUserSession::class);

		return new WhiteboardController(
			'whiteboard',
			$request,
			new GetUserFromIdServiceFactory(
				$this->createMock(ShareManager::class),
				$userManager,
				$userSession,
			),
			new GetFileServiceFactory($rootFolder, $this->createMock(ShareManager::class), $logger),
			new JWTService($configService),
			new WhiteboardContentService($logger, $configService),
			new WhiteboardLibraryService($folders, $config, $logger),
			new CanvasTemplateService($folders, $logger),
			new ExceptionService($logger),
			$configService,
			$logger,
			$cacheFactory,
			$groupManager,
		);
	}

	public function testUpdateRejectsReadOnlyFile(): void {
		$controller = $this->makeController(false, [], Constants::PERMISSION_READ);

		$response = $controller->update(123, [
			'data' => [
				'elements' => [['id' => 'el', 'type' => 'rectangle']],
			],
		]);

		$this->assertSame(Http::STATUS_FORBIDDEN, $response->getStatus());
		$this->assertSame('Permission denied', $response->getData()['message']);
	}

	public function testUpdateCanonicalizesForgedCreator(): void {
		$controller = $this->makeController(false, []);

		$response = $controller->update(123, [
			'data' => [
				'elements' => [[
					'id' => 'forged-element',
					'type' => 'text',
					'customData' => [
						'creator' => ['uid' => 'alice', 'displayName' => 'Alice', 'createdAt' => 1],
					],
				]],
			],
		]);

		$this->assertSame(Http::STATUS_OK, $response->getStatus());
		$this->assertSame('success', $response->getData()['status']);
	}

	public function testSaveLibraryOrgScopeForbiddenForNonAdmin(): void {
		$controller = $this->makeController(false, [
			'scope' => 'org',
			'name' => 'Kit',
			'items' => [['elements' => [['type' => 'rectangle']]]],
		]);

		$response = $controller->saveLibrary();

		$this->assertSame(Http::STATUS_FORBIDDEN, $response->getStatus());
	}

	public function testDeleteLibraryOrgScopeForbiddenForNonAdmin(): void {
		$controller = $this->makeController(false, []);

		$response = $controller->deleteLibrary('org', 'Kit');

		$this->assertSame(Http::STATUS_FORBIDDEN, $response->getStatus());
	}

	public function testPublishTemplateOrgScopeForbiddenForNonAdmin(): void {
		$controller = $this->makeController(false, [
			'scope' => 'org',
			'name' => 'Kanban',
			'data' => ['elements' => [['type' => 'rectangle']]],
		]);

		$response = $controller->publishCanvasTemplate();

		$this->assertSame(Http::STATUS_FORBIDDEN, $response->getStatus());
	}

	public function testPublishTemplatePersonalCreatesTemplateFile(): void {
		$controller = $this->makeController(false, [
			'scope' => 'personal',
			'name' => 'Retro board',
			'data' => ['elements' => [['type' => 'rectangle']]],
		]);

		$response = $controller->publishCanvasTemplate();

		$this->assertSame(Http::STATUS_CREATED, $response->getStatus());
		$this->assertSame(['name' => 'Retro board', 'scope' => 'personal'], $response->getData()['canvasTemplate']);
		$this->assertArrayHasKey('Retro board.whiteboard', $this->templatesChildren);
	}

	public function testPublishTemplateRejectsNonArrayData(): void {
		$controller = $this->makeController(true, [
			'scope' => 'personal',
			'name' => 'Bad',
			'data' => 'not-an-array',
		]);

		$response = $controller->publishCanvasTemplate();

		$this->assertSame(Http::STATUS_BAD_REQUEST, $response->getStatus());
	}
}
