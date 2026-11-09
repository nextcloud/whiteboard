<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Controller;

use Firebase\JWT\JWT;
use OCA\Whiteboard\Consts\JWTConsts;
use OCA\Whiteboard\Exception\BoardBusyException;
use OCA\Whiteboard\Exception\BoardReplacedException;
use OCA\Whiteboard\Exception\BoardUnreadableException;
use OCA\Whiteboard\Model\BoardState;
use OCA\Whiteboard\Service\Authentication\GetUserFromIdServiceFactory;
use OCA\Whiteboard\Service\BoardSyncService;
use OCA\Whiteboard\Service\CanvasTemplateService;
use OCA\Whiteboard\Service\ConfigService;
use OCA\Whiteboard\Service\ExceptionService;
use OCA\Whiteboard\Service\File\GetFileServiceFactory;
use OCA\Whiteboard\Service\JWTService;
use OCA\Whiteboard\Service\WhiteboardFolderService;
use OCA\Whiteboard\Service\WhiteboardLibraryService;
use OCP\AppFramework\Http;
use OCP\AppFramework\Services\IAppConfig;
use OCP\Constants;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\IUserFolder;
use OCP\Files\Template\ITemplateManager;
use OCP\IConfig;
use OCP\IGroupManager;
use OCP\IRequest;
use OCP\IUser;
use OCP\IUserManager;
use OCP\IUserSession;
use OCP\L10N\IFactory;
use OCP\Share\IManager as ShareManager;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;
use Test\TestCase;

class WhiteboardControllerTest extends TestCase {
	private const SECRET = 'test-secret-at-least-32-bytes-long';
	private const UID = 'bob';

	/** Captured writes into the user's Templates folder, name => File mock. */
	private array $templatesChildren = [];

	private File&MockObject $whiteboardFile;

	private BoardSyncService&MockObject $boardSync;

	private function makeController(
		bool $isAdmin,
		array $params,
		int $whiteboardFilePermissions = Constants::PERMISSION_READ | Constants::PERMISSION_UPDATE,
		array $jwtClaims = [],
		string $storedSecret = self::SECRET,
	): WhiteboardController {
		$appConfig = $this->createMock(IAppConfig::class);
		$appConfig->method('getAppValueString')->willReturn($storedSecret);
		$systemConfig = $this->createMock(IConfig::class);
		$systemConfig->method('getSystemValueString')->willReturnMap([['secret', '', 'instance-secret-of-this-nextcloud']]);
		$configService = new ConfigService($appConfig, $systemConfig);

		$request = $this->createMock(IRequest::class);
		// A token of board 123, as the token endpoint makes it
		$jwt = JWT::encode($jwtClaims + ['userid' => self::UID, 'fileId' => 123, 'exp' => time() + 300], $configService->getJwtSecretKey(), JWTConsts::JWT_ALGORITHM);
		$request->method('getHeader')->willReturnCallback(static fn (string $name): string => $name === 'Authorization' ? 'Bearer ' . $jwt : '');
		$request->method('getParam')->willReturnCallback(static fn (string $key, $default = null) => $params[$key] ?? $default);

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

		$userFolder = $this->createMock(interface_exists(IUserFolder::class) ? IUserFolder::class : Folder::class);
		$userFolder->method('get')->with('Templates/')->willReturn($templatesFolder);
		$whiteboardFile = $this->createMock(File::class);
		$this->whiteboardFile = $whiteboardFile;
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
		$folders = new WhiteboardFolderService($templateManager, $rootFolder, $config, $logger, $this->createMock(IFactory::class), static fn (): bool => true);

		$this->boardSync = $this->createMock(BoardSyncService::class);

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
			$this->boardSync,
			new WhiteboardLibraryService($folders, $config, $logger),
			new CanvasTemplateService($folders, $logger),
			new ExceptionService($logger),
			$logger,
			$groupManager,
		);
	}

	public function testBoardsOpenAndSaveWithoutAConfiguredSecret(): void {
		$controller = $this->makeController(false, ['schemaVersion' => 3], storedSecret: '');
		$this->boardSync->method('read')->willReturn(['sync' => ['epoch' => 'e', 'rev' => 1], 'data' => ['elements' => []]]);
		$this->boardSync->method('save')->willReturn(['sync' => ['epoch' => 'e', 'rev' => 2], 'delta' => ['elements' => [], 'files' => []]]);

		$this->assertSame(Http::STATUS_OK, $controller->show(123)->getStatus());
		$this->assertSame(Http::STATUS_OK, $controller->update(123, ['elements' => []], ['epoch' => 'e', 'since' => 1])->getStatus());
	}

	public function testTokenOfAnotherBoardIsRefused(): void {
		$controller = $this->makeController(false, ['schemaVersion' => 3], jwtClaims: ['fileId' => 999]);
		$this->boardSync->expects($this->never())->method('read');
		$this->boardSync->expects($this->never())->method('save');

		$this->assertSame(Http::STATUS_UNAUTHORIZED, $controller->show(123)->getStatus());
		$this->assertSame(Http::STATUS_UNAUTHORIZED, $controller->update(123, ['elements' => []], ['epoch' => 'e', 'since' => 1])->getStatus());
	}

	public function testUpdateRejectsReadOnlyFile(): void {
		$controller = $this->makeController(false, [], Constants::PERMISSION_READ);

		$response = $controller->update(123, [
			'elements' => [['id' => 'el', 'type' => 'rectangle']],
		]);

		$this->assertSame(self::contract()['answers']['forbidden']['status'], $response->getStatus());
		$this->assertSame('Permission denied', $response->getData()['message']);
	}

	public function testUpdateRejectsReadOnlyToken(): void {
		$controller = $this->makeController(false, [], Constants::PERMISSION_READ | Constants::PERMISSION_UPDATE, ['isFileReadOnly' => true]);

		$response = $controller->update(123, [
			'elements' => [['id' => 'el', 'type' => 'rectangle']],
		]);

		$this->assertSame(self::contract()['answers']['forbidden']['status'], $response->getStatus());
		$this->assertSame('Permission denied', $response->getData()['message']);
	}

	/**
	 * What clients and Nextcloud agree on (`tests/fixtures/board-sync-contract.json`, read by the client tests too)
	 *
	 * @return array{schemaVersion: int, answers: array<string,array{status: int, code: string}>}
	 */
	private static function contract(): array {
		return json_decode((string)file_get_contents(__DIR__ . '/../../fixtures/board-sync-contract.json'), true);
	}

	public function testUpdateTakesTheSchemaVersionOfThisClient(): void {
		$controller = $this->makeController(false, ['schemaVersion' => self::contract()['schemaVersion']]);
		$this->boardSync->expects($this->once())->method('save')->willReturn(['sync' => ['epoch' => 'epoch1', 'rev' => 4, 'restored' => false], 'delta' => ['elements' => [], 'files' => []]]);

		$response = $controller->update(123, ['elements' => []], ['epoch' => 'epoch1', 'since' => 3]);

		$this->assertSame(Http::STATUS_OK, $response->getStatus());
	}

	public static function outdatedClientParams(): array {
		return [
			'missing marker' => [[]],
			'wrong marker' => [['schemaVersion' => 1]],
			'marker of whole-scene clients' => [['schemaVersion' => 2]],
			'marker as string' => [['schemaVersion' => '3']],
		];
	}

	#[DataProvider('outdatedClientParams')]
	public function testUpdateRejectsOutdatedClientWithoutWriting(array $params): void {
		$controller = $this->makeController(false, $params);
		$this->boardSync->expects($this->never())->method('save');

		$response = $controller->update(123, [
			'elements' => [['id' => 'el', 'type' => 'rectangle']],
		]);

		$this->assertSame(self::contract()['answers']['upgrade']['status'], $response->getStatus());
		$this->assertSame(['status' => 'error', 'code' => self::contract()['answers']['upgrade']['code']], $response->getData());
	}

	public function testUpdateMergesTheChangesOfTheClient(): void {
		$controller = $this->makeController(false, ['schemaVersion' => 3]);
		$element = ['id' => 'el', 'type' => 'rectangle', 'version' => 2, 'versionNonce' => 1];
		$this->boardSync->expects($this->once())->method('save')
			->with($this->whiteboardFile, 'epoch1', 4, [$element], ['f' => ['id' => 'f']], $this->anything(), false)
			->willReturn(['sync' => ['epoch' => 'epoch1', 'rev' => 5], 'delta' => ['elements' => [$element], 'files' => []]]);

		$response = $controller->update(123, ['elements' => [$element], 'files' => ['f' => ['id' => 'f']]], ['epoch' => 'epoch1', 'since' => 4]);

		$this->assertSame(Http::STATUS_OK, $response->getStatus());
		$this->assertSame(['epoch' => 'epoch1', 'rev' => 5], $response->getData()['sync']);
	}

	public function testUpdateOfARepairReplacesTheBoardThatCannotBeRead(): void {
		$controller = $this->makeController(false, ['schemaVersion' => 3]);
		$this->boardSync->expects($this->once())->method('save')
			->with($this->whiteboardFile, 'epoch1', 4, [], [], $this->anything(), true)
			->willReturn(['sync' => ['epoch' => 'epoch1', 'rev' => 5], 'delta' => ['elements' => [], 'files' => []]]);

		// As src/sync/boardSync.ts sends a repair
		$response = $controller->update(123, ['elements' => []], ['epoch' => 'epoch1', 'since' => 4, 'repair' => true]);

		$this->assertSame(Http::STATUS_OK, $response->getStatus());
	}

	public function testUpdatePassesBoardSettings(): void {
		$controller = $this->makeController(false, ['schemaVersion' => 3]);
		$this->boardSync->expects($this->once())->method('save')
			->with($this->whiteboardFile, 'epoch1', 4, [], [], $this->anything(), false, ['viewBackgroundColor' => '#ffec99'])
			->willReturn(['sync' => ['epoch' => 'epoch1', 'rev' => 5], 'delta' => ['elements' => [], 'files' => [], 'settings' => ['viewBackgroundColor' => '#ffec99']]]);

		$response = $controller->update(123, ['elements' => [], 'settings' => ['viewBackgroundColor' => '#ffec99']], ['epoch' => 'epoch1', 'since' => 4]);

		$this->assertSame(Http::STATUS_OK, $response->getStatus());
	}

	public function testUpdateOfAReplacedBoardTellsTheNewEpoch(): void {
		$controller = $this->makeController(false, ['schemaVersion' => 3]);
		$this->boardSync->method('save')->willThrowException(new BoardReplacedException($this->state('epoch2', 9)));

		$response = $controller->update(123, ['elements' => []], ['epoch' => 'epoch1', 'since' => 4]);

		$this->assertSame(self::contract()['answers']['replaced']['status'], $response->getStatus());
		$this->assertSame(['code' => self::contract()['answers']['replaced']['code'], 'sync' => ['epoch' => 'epoch2', 'rev' => 9, 'restored' => false]], $response->getData());
	}

	public function testUpdateOfAnUnreadableBoardAsksForARepair(): void {
		$controller = $this->makeController(false, ['schemaVersion' => 3]);
		$this->boardSync->method('save')->willThrowException(new BoardUnreadableException($this->state('epoch1', 3)));

		$response = $controller->update(123, ['elements' => []], ['epoch' => 'epoch1', 'since' => 3]);

		$this->assertSame(self::contract()['answers']['unreadable']['status'], $response->getStatus());
		$this->assertSame(self::contract()['answers']['unreadable']['code'], $response->getData()['code']);
	}

	public function testUpdateOfABusyBoardAsksToRetry(): void {
		$controller = $this->makeController(false, ['schemaVersion' => 3]);
		$this->boardSync->method('save')->willThrowException(new BoardBusyException());

		$response = $controller->update(123, ['elements' => []], ['epoch' => 'epoch1', 'since' => 3]);

		$this->assertSame(self::contract()['answers']['busy']['status'], $response->getStatus());
		$this->assertSame(self::contract()['answers']['busy']['code'], $response->getData()['code']);
	}

	public function testShowReturnsTheChangesSinceTheClientsRevision(): void {
		$controller = $this->makeController(false, []);
		$this->boardSync->expects($this->once())->method('read')->with($this->whiteboardFile, 'epoch1', 7)
			->willReturn(['sync' => ['epoch' => 'epoch1', 'rev' => 8], 'delta' => ['elements' => [], 'files' => []]]);

		$response = $controller->show(123, 'epoch1', 7);

		$this->assertSame(['epoch' => 'epoch1', 'rev' => 8], $response->getData()['sync']);
	}

	private function state(string $epoch, int $rev): BoardState {
		return new BoardState(123, $epoch, $rev, str_repeat('0', 64), null, null, null, false);
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
