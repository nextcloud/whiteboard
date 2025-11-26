<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Listener;

use OCA\Viewer\Event\LoadViewer;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventDispatcher;
use OCP\EventDispatcher\IEventListener;

/** @template-implements IEventListener<LoadViewer|Event> */
class LoadTextEditorListener implements IEventListener {
	public function __construct(
		private IEventDispatcher $eventDispatcher,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if (!($event instanceof LoadViewer)) {
			return;
		}

		// Load the Text editor if available
		if (class_exists('OCA\Text\Event\LoadEditor')) {
			$this->eventDispatcher->dispatchTyped(new \OCA\Text\Event\LoadEditor());
		}
	}
}
