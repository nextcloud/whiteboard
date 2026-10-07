<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Listener;

use OCA\Viewer\Event\LoadViewer;
use OCA\Whiteboard\Service\ConfigService;
use OCP\AppFramework\Http\Events\BeforeTemplateRenderedEvent;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\AppFramework\Services\IAppConfig;
use OCP\AppFramework\Services\IInitialState;
use OCP\IConfig;
use OCP\IGroupManager;
use OCP\IUserSession;
use OCP\Util;
use PHPUnit\Framework\MockObject\Stub;
use Test\TestCase;

class LoadViewerListenerTest extends TestCase {
	private IInitialState&Stub $initialState;
	/** @var array<string, mixed> */
	private array $provided = [];
	private LoadViewerListener $listener;

	#[\Override]
	protected function setUp(): void {
		parent::setUp();

		// The scripts a page loads are kept statically: start every test from none
		foreach (['scripts', 'scriptsInit', 'scriptDeps'] as $property) {
			(new \ReflectionProperty(Util::class, $property))->setValue(null, []);
		}

		$this->provided = [];
		$this->initialState = $this->createStub(IInitialState::class);
		$this->initialState->method('provideInitialState')
			->willReturnCallback(function (string $key, mixed $value): void {
				$this->provided[$key] = $value;
			});

		$this->listener = new LoadViewerListener(
			$this->initialState,
			new ConfigService($this->createStub(IAppConfig::class), $this->createStub(IConfig::class)),
			$this->createStub(IUserSession::class),
			$this->createStub(IGroupManager::class),
		);
	}

	private function renderedPage(string $renderAs): BeforeTemplateRenderedEvent {
		return new BeforeTemplateRenderedEvent(true, new TemplateResponse('core', 'empty', [], $renderAs));
	}

	public function testRegistersTheViewerHandlerOnEveryPage(): void {
		$this->listener->handle($this->renderedPage(TemplateResponse::RENDER_AS_USER));

		$this->assertContains('whiteboard/js/whiteboard-viewer', Util::getScripts());
		$this->assertNotContains('whiteboard/js/whiteboard-main', Util::getScripts());
		$this->assertFalse($this->provided['legacyViewer']);
		$this->assertArrayHasKey('collabBackendUrl', $this->provided);
	}

	public function testLeavesTheErrorPageAlone(): void {
		$this->listener->handle($this->renderedPage(TemplateResponse::RENDER_AS_ERROR));

		$this->assertNotContains('whiteboard/js/whiteboard-viewer', Util::getScripts());
		$this->assertSame([], $this->provided);
	}

	public function testLoadsTheBoardForTheViewerApp(): void {
		$this->listener->handle(new LoadViewer());

		$this->assertContains('whiteboard/js/whiteboard-main', Util::getScripts());
		$this->assertNotContains('whiteboard/js/whiteboard-viewer', Util::getScripts());
		$this->assertArrayNotHasKey('legacyViewer', $this->provided);
		$this->assertArrayHasKey('collabBackendUrl', $this->provided);
	}
}
