<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use OCP\AppFramework\Services\IAppConfig;
use OCP\IConfig;
use PHPUnit\Framework\Attributes\DataProvider;
use Test\TestCase;

class ConfigServiceTest extends TestCase {
	#[DataProvider('backendCspDomainProvider')]
	public function testCollabBackendCspConnectDomains(string $url, array $expected): void {
		$service = $this->createService($url);

		$this->assertSame($expected, $service->getCollabBackendCspConnectDomains());
	}

	public static function backendCspDomainProvider(): array {
		return [
			'https backend also allows wss' => [
				'https://whiteboard.example.com/socket.io/',
				['https://whiteboard.example.com', 'wss://whiteboard.example.com'],
			],
			'http backend with port also allows ws' => [
				'http://whiteboard.local:3002/base/',
				['http://whiteboard.local:3002', 'ws://whiteboard.local:3002'],
			],
			'wss backend also allows https' => [
				'wss://whiteboard.example.com:8443/socket.io',
				['wss://whiteboard.example.com:8443', 'https://whiteboard.example.com:8443'],
			],
			'ws backend also allows http' => [
				'ws://127.0.0.1:3002/socket.io',
				['ws://127.0.0.1:3002', 'http://127.0.0.1:3002'],
			],
			'ipv6 backend' => [
				'https://[::1]:3002/socket.io',
				['https://[::1]:3002', 'wss://[::1]:3002'],
			],
			'underscore backend host' => [
				'https://whiteboard_backend.local:3002/socket.io',
				['https://whiteboard_backend.local:3002', 'wss://whiteboard_backend.local:3002'],
			],
			'trailing dot fqdn backend host' => [
				'https://whiteboard.example.com.:3002/socket.io',
				['https://whiteboard.example.com.:3002', 'wss://whiteboard.example.com.:3002'],
			],
			'dash edge backend labels' => [
				'https://-whiteboard.example-.local:3002/socket.io',
				['https://-whiteboard.example-.local:3002', 'wss://-whiteboard.example-.local:3002'],
			],
		];
	}

	#[DataProvider('invalidBackendUrlProvider')]
	public function testInvalidCollabBackendUrlsAreNotUsedForCsp(string $url): void {
		$service = $this->createService($url);

		$this->assertSame([], $service->getCollabBackendCspConnectDomains());
	}

	public static function invalidBackendUrlProvider(): array {
		return [
			'empty' => [''],
			'missing scheme' => ['//whiteboard.example.com'],
			'unsupported scheme' => ['ftp://whiteboard.example.com'],
			'javascript scheme' => ['javascript:alert(1)'],
			'host with csp delimiter' => ['https://whiteboard.example.com;script-src *'],
			'host with quoted source injection' => ["https://whiteboard.example.com 'unsafe-eval'"],
			'wildcard host' => ['https://*.example.com'],
			'empty label' => ['https://whiteboard..example.com'],
			'invalid ipv6 literal' => ['https://[not-ipv6]:3002'],
		];
	}

	private function createService(string $backendUrl): ConfigService {
		$appConfig = $this->createMock(IAppConfig::class);
		$appConfig->method('getAppValueString')
			->with('collabBackendUrl')
			->willReturn($backendUrl);

		return new ConfigService($appConfig, $this->createMock(IConfig::class));
	}
}
