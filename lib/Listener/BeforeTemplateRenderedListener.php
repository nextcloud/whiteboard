<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */


namespace OCA\Whiteboard\Listener;

use OCA\Files_Sharing\Event\BeforeTemplateRenderedEvent;
use OCA\Whiteboard\Service\ConfigService;
use OCP\AppFramework\Services\IInitialState;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventDispatcher;
use OCP\EventDispatcher\IEventListener;
use OCP\Files\File;
use OCP\Files\NotFoundException;
use OCP\Util;

/** @template-implements IEventListener<BeforeTemplateRenderedEvent|Event> */
/**
 * @psalm-suppress UndefinedClass
 * @psalm-suppress MissingTemplateParam
 */
class BeforeTemplateRenderedListener implements IEventListener {
	public function __construct(
		private IInitialState $initialState,
		private ConfigService $configService,
		private IEventDispatcher $eventDispatcher,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if (!($event instanceof BeforeTemplateRenderedEvent)) {
			return;
		}

		if ($event->getScope() === BeforeTemplateRenderedEvent::SCOPE_PUBLIC_SHARE_AUTH) {
			return;
		}

		try {
			$node = $event->getShare()->getNode();
		} catch (NotFoundException) {
			return;
		}

		if (!($node instanceof File)) {
			return;
		}

		if ($node->getMimetype() !== 'application/vnd.excalidraw+json') {
			return;
		}

		// Load the Text editor if available for table insertion support
		if (class_exists('OCA\Text\Event\LoadEditor')) {
			$this->eventDispatcher->dispatchTyped(new \OCA\Text\Event\LoadEditor());
		}

		Util::addScript('whiteboard', 'whiteboard-main');
		Util::addStyle('whiteboard', 'whiteboard-main');

		$this->initialState->provideInitialState('file_id', $node->getId());
		$this->initialState->provideInitialState('collabBackendUrl', $this->configService->getCollabBackendUrl());
		$this->initialState->provideInitialState('maxFileSize', $this->configService->getMaxFileSize());
	}
}
