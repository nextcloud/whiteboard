<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Listener;

use OCP\AppFramework\Http\Events\BeforeTemplateRenderedEvent;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventDispatcher;
use OCP\EventDispatcher\IEventListener;

/** @template-implements IEventListener<BeforeTemplateRenderedEvent|Event> */
class LoadTextEditorListener implements IEventListener {
	/**
	 * @psalm-suppress PossiblyUnusedMethod
	 */
	public function __construct(
		private IEventDispatcher $eventDispatcher,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if (!($event instanceof BeforeTemplateRenderedEvent)
			|| $event->getResponse()->getRenderAs() === TemplateResponse::RENDER_AS_ERROR) {
			return;
		}

		// Load the Text editor if available
		if (class_exists('OCA\Text\Event\LoadEditor')) {
			$this->eventDispatcher->dispatchTyped(new \OCA\Text\Event\LoadEditor());
		}
	}
}
