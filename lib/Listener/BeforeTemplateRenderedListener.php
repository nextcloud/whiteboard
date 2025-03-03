<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */


namespace OCA\Whiteboard\Listener;

use OCA\Files_Sharing\Event\BeforeTemplateRenderedEvent;
use OCP\AppFramework\Services\IInitialState;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Files\NotFoundException;

/** @template-implements IEventListener<BeforeTemplateRenderedEvent|Event> */
/**
 * @psalm-suppress UndefinedClass
 * @psalm-suppress MissingTemplateParam
 */
class BeforeTemplateRenderedListener implements IEventListener {
	public function __construct(
		private IInitialState $initialState,
	) {
	}

	/**
	 * @throws NotFoundException
	 */
	#[\Override]
	public function handle(Event $event): void {
		if (!($event instanceof BeforeTemplateRenderedEvent)) {
			return;
		}

		$this->initialState->provideInitialState(
			'file_id',
			$event->getShare()->getNodeId()
		);
	}
}
