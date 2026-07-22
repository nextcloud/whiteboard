<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Listener;

use OC\Security\CSP\ContentSecurityPolicy;
use OC\Security\CSP\ContentSecurityPolicyManager;
use OCA\Whiteboard\Service\ConfigService;
use OCP\AppFramework\Services\IAppConfig;
use OCP\EventDispatcher\IEventDispatcher;
use OCP\IConfig;
use OCP\IRequest;
use OCP\Security\CSP\AddContentSecurityPolicyEvent;
use PHPUnit\Framework\Attributes\DataProvider;
use Test\TestCase;

class AddContentSecurityPolicyListenerTest extends TestCase {
	#[DataProvider('whiteboardPageProvider')]
	public function testAddsCollaborationCspOnWhiteboardPages(string $pathInfo): void {
		$policy = $this->handleRequest($pathInfo);

		$this->assertContains('https://whiteboard.example.com:3002', $policy->getAllowedConnectDomains());
		$this->assertContains('wss://whiteboard.example.com:3002', $policy->getAllowedConnectDomains());
		$this->assertContains('https://libraries.excalidraw.com', $policy->getAllowedConnectDomains());
		$this->assertContains('\'self\'', $policy->getAllowedWorkerSrcDomains());
		$this->assertNotContains('*', $policy->getAllowedConnectDomains());
		$this->assertNotContains('*', $policy->getAllowedWorkerSrcDomains());
	}

	public static function whiteboardPageProvider(): array {
		return [
			'files app' => ['/apps/files'],
			'files app with index.php' => ['/index.php/apps/files/files/123?dir=/&openfile=true'],
			'files direct editing' => ['/apps/files/directEditing/token'],
			'direct file route' => ['/f/12345'],
			'direct file route with index.php' => ['/index.php/f/12345'],
			'public share route' => ['/s/shareToken'],
			'public share route with index.php' => ['/index.php/s/shareToken'],
			'talk app' => ['/apps/spreed'],
			'talk room' => ['/apps/spreed/room/abc123'],
			'talk room with index.php' => ['/index.php/apps/spreed/room/abc123'],
			'talk call route' => ['/call/abc123'],
			'talk call route with index.php' => ['/index.php/call/abc123'],
			'recording route' => ['/apps/whiteboard/recording/123/alice'],
		];
	}

	#[DataProvider('nonWhiteboardPageProvider')]
	public function testDoesNotAddCollaborationCspOutsideWhiteboardPages(string $pathInfo, string $method = 'GET'): void {
		$policy = $this->handleRequest($pathInfo, $method);

		$this->assertNotContains('https://whiteboard.example.com:3002', $policy->getAllowedConnectDomains());
		$this->assertNotContains('wss://whiteboard.example.com:3002', $policy->getAllowedConnectDomains());
		$this->assertNotContains('https://libraries.excalidraw.com', $policy->getAllowedConnectDomains());
		$this->assertNotContains('\'self\'', $policy->getAllowedWorkerSrcDomains());
	}

	public static function nonWhiteboardPageProvider(): array {
		return [
			'other app page' => ['/apps/dashboard'],
			'files api' => ['/apps/files/api/v1/thumbnail/32/32/Photos/image.jpg'],
			'files api with index.php' => ['/index.php/apps/files/api/v1/thumbnail/32/32/Photos/image.jpg'],
			'files service worker route' => ['/apps/files/preview-service-worker.js'],
			'files service worker route with index.php' => ['/index.php/apps/files/preview-service-worker.js'],
			'whiteboard data api' => ['/apps/whiteboard/12345'],
			'files post request' => ['/apps/files', 'POST'],
			'talk post request' => ['/apps/spreed', 'POST'],
			'files_external app is not files' => ['/apps/files_external'],
		];
	}

	public function testAddsStaticSourcesEvenWithoutConfiguredBackend(): void {
		$policy = $this->handleRequest('/apps/spreed/room/abc123', 'GET', '');

		$this->assertContains('\'self\'', $policy->getAllowedWorkerSrcDomains());
		$this->assertSame(['\'self\'', 'https://libraries.excalidraw.com'], $policy->getAllowedConnectDomains());
	}

	public function testDoesNotAllowExternalLibrariesWhenDisabled(): void {
		$policy = $this->handleRequest('/apps/files', 'GET', '', true);

		$this->assertSame(['\'self\''], $policy->getAllowedConnectDomains());
	}

	private function handleRequest(
		string $pathInfo,
		string $method = 'GET',
		string $backendUrl = 'https://whiteboard.example.com:3002/socket.io/',
		bool $disableExternalLibraries = false,
	): ContentSecurityPolicy {
		$request = $this->createMock(IRequest::class);
		$request->method('getMethod')->willReturn($method);
		$request->method('getPathInfo')->willReturn($pathInfo);

		$listener = new AddContentSecurityPolicyListener(
			$request,
			$this->createConfigService($backendUrl, $disableExternalLibraries),
		);

		$dispatcher = $this->createMock(IEventDispatcher::class);
		$policyManager = new ContentSecurityPolicyManager($dispatcher);

		$listener->handle(new AddContentSecurityPolicyEvent($policyManager));

		return $policyManager->getDefaultPolicy();
	}

	private function createConfigService(string $backendUrl, bool $disableExternalLibraries): ConfigService {
		$appConfig = $this->createMock(IAppConfig::class);
		$appConfig->method('getAppValueString')
			->with('collabBackendUrl')
			->willReturn($backendUrl);
		$appConfig->method('getAppValueBool')
			->with('disable_external_libraries')
			->willReturn($disableExternalLibraries);

		return new ConfigService($appConfig, $this->createMock(IConfig::class));
	}
}
