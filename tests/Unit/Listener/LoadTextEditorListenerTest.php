<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Listener;

use OCA\Viewer\Event\LoadViewer;
use OCP\AppFramework\Http\Events\BeforeTemplateRenderedEvent;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventDispatcher;
use PHPUnit\Framework\MockObject\MockObject;
use Test\TestCase;

class LoadTextEditorListenerTest extends TestCase {
	private IEventDispatcher&MockObject $eventDispatcher;
	private LoadTextEditorListener $listener;

	#[\Override]
	protected function setUp(): void {
		parent::setUp();

		$this->eventDispatcher = $this->createMock(IEventDispatcher::class);
		$this->listener = new LoadTextEditorListener($this->eventDispatcher);
	}

	private function renderedPage(string $renderAs): BeforeTemplateRenderedEvent {
		return new BeforeTemplateRenderedEvent(true, new TemplateResponse('core', 'empty', [], $renderAs));
	}

	private function expectTextLoaded(): void {
		if (class_exists('OCA\Text\Event\LoadEditor')) {
			$this->eventDispatcher->expects($this->once())
				->method('dispatchTyped')
				->with($this->isInstanceOf('OCA\Text\Event\LoadEditor'));
		} else {
			$this->eventDispatcher->expects($this->never())->method('dispatchTyped');
		}
	}

	public function testLoadsTextOnEveryPage(): void {
		$this->expectTextLoaded();

		$this->listener->handle($this->renderedPage(TemplateResponse::RENDER_AS_USER));
	}

	public function testLoadsTextForTheViewerApp(): void {
		$this->expectTextLoaded();

		$this->listener->handle(new LoadViewer());
	}

	public function testLeavesTheErrorPageAlone(): void {
		$this->eventDispatcher->expects($this->never())->method('dispatchTyped');

		$this->listener->handle($this->renderedPage(TemplateResponse::RENDER_AS_ERROR));
	}

	public function testIgnoresOtherEvents(): void {
		$this->eventDispatcher->expects($this->never())->method('dispatchTyped');

		$this->listener->handle(new Event());
	}
}
