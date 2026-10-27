<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Controller;

use Firebase\JWT\JWT;
use OCA\Whiteboard\Consts\JWTConsts;
use OCA\Whiteboard\Service\Authentication\AuthenticateUserServiceFactory;
use OCA\Whiteboard\Service\ConfigService;
use OCA\Whiteboard\Service\File\GetFileServiceFactory;
use OCA\Whiteboard\Service\JWTService;
use OCP\AppFramework\Http;
use OCP\AppFramework\Services\IAppConfig;
use OCP\AppFramework\Services\IInitialState;
use OCP\Constants;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\IUserFolder;
use OCP\IConfig;
use OCP\IDateTimeZone;
use OCP\IRequest;
use OCP\IURLGenerator;
use OCP\IUser;
use OCP\IUserManager;
use OCP\IUserSession;
use OCP\Share\IManager as ShareManager;
use Psr\Log\LoggerInterface;
use Test\TestCase;

class RecordingControllerTest extends TestCase {
	private const SECRET = 'test-secret-at-least-32-bytes-long';
	private const UID = 'bob';

	public function testUploadKeepsAnEarlierRecordingWithTheSameName(): void {
		$uploadedFile = tempnam(sys_get_temp_dir(), 'recording');
		file_put_contents($uploadedFile, 'webm');

		$jwt = JWT::encode(['userid' => self::UID, 'exp' => time() + 300], self::SECRET, JWTConsts::JWT_ALGORITHM);
		$request = $this->createMock(IRequest::class);
		$request->method('getHeader')->willReturnCallback(static fn (string $name): string => $name === 'Authorization' ? 'Bearer ' . $jwt : '');
		$request->method('getUploadedFile')->with('recording')->willReturn(['tmp_name' => $uploadedFile]);

		$board = $this->createMock(File::class);
		$board->method('getName')->willReturn('Board.whiteboard');
		$board->method('getPermissions')->willReturn(Constants::PERMISSION_READ | Constants::PERMISSION_UPDATE);

		$recordings = $this->createMock(Folder::class);
		$recordings->method('getNonExistingName')->willReturnCallback(static fn (string $name): string => str_replace('.webm', ' (2).webm', $name));
		$recordings->expects($this->once())
			->method('newFile')
			->with($this->stringEndsWith(') (2).webm'), 'webm')
			->willReturn($this->createMock(File::class));

		$userFolder = $this->createMock(interface_exists(IUserFolder::class) ? IUserFolder::class : Folder::class);
		$userFolder->method('getFirstNodeById')->willReturn($board);
		$userFolder->method('nodeExists')->with('Whiteboard Recordings')->willReturn(true);
		$userFolder->method('get')->with('Whiteboard Recordings')->willReturn($recordings);
		$rootFolder = $this->createMock(IRootFolder::class);
		$rootFolder->method('getUserFolder')->with(self::UID)->willReturn($userFolder);

		$user = $this->createMock(IUser::class);
		$user->method('getUID')->willReturn(self::UID);
		$userManager = $this->createMock(IUserManager::class);
		$userManager->method('get')->with(self::UID)->willReturn($user);

		$appConfig = $this->createMock(IAppConfig::class);
		$appConfig->method('getAppValueString')->willReturn(self::SECRET);
		$configService = new ConfigService($appConfig, $this->createMock(IConfig::class));
		$dateTimeZone = $this->createMock(IDateTimeZone::class);
		$dateTimeZone->method('getTimeZone')->willReturn(new \DateTimeZone('UTC'));
		$logger = $this->createMock(LoggerInterface::class);

		$controller = new RecordingController(
			$request,
			$this->createMock(IInitialState::class),
			$configService,
			new AuthenticateUserServiceFactory($this->createMock(ShareManager::class), $this->createMock(IUserSession::class)),
			new GetFileServiceFactory($rootFolder, $this->createMock(ShareManager::class), $logger),
			new JWTService($configService),
			$userManager,
			$rootFolder,
			$dateTimeZone,
			$this->createMock(IURLGenerator::class),
			$logger,
		);

		$response = $controller->upload(123);
		unlink($uploadedFile);

		$this->assertSame(Http::STATUS_OK, $response->getStatus());
		$this->assertStringStartsWith('Board (', $response->getData()['filename']);
		$this->assertStringEndsWith(') (2).webm', $response->getData()['filename']);
	}
}
