<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use Firebase\JWT\JWT;
use OCA\Whiteboard\Consts\JWTConsts;
use OCA\Whiteboard\Exception\UnauthorizedException;
use OCP\AppFramework\Services\IAppConfig;
use OCP\IConfig;
use Test\TestCase;

final class JWTServiceTest extends TestCase {
	private const SECRET = 'a-secret-long-enough-for-hs256-tokens-0123456789';

	private function service(): JWTService {
		$appConfig = $this->createMock(IAppConfig::class);
		$appConfig->method('getAppValueString')->willReturn(self::SECRET);
		return new JWTService(new ConfigService($appConfig, $this->createMock(IConfig::class)));
	}

	private function token(array $claims): string {
		return JWT::encode($claims + ['exp' => time() + 300], self::SECRET, JWTConsts::JWT_ALGORITHM);
	}

	public function testATokenOfTheBoardGivesItsUser(): void {
		$this->assertSame('alice', $this->service()->getUserIdFromJWT($this->token(['userid' => 'alice', 'fileId' => 7]), 7));
	}

	public function testATokenOfAnotherBoardIsRefused(): void {
		$this->expectException(UnauthorizedException::class);
		$this->service()->getUserIdFromJWT($this->token(['userid' => 'alice', 'fileId' => 8]), 7);
	}

	public function testATokenOfNoBoardIsRefusedForABoard(): void {
		// As the tokens of the admin settings
		$this->expectException(UnauthorizedException::class);
		$this->service()->getUserIdFromJWT($this->token(['userid' => 'alice']), 7);
	}

	public function testATokenWithoutAUserIsRefused(): void {
		$this->expectException(UnauthorizedException::class);
		$this->service()->getUserIdFromJWT($this->token(['fileId' => 7]), 7);
	}
}
