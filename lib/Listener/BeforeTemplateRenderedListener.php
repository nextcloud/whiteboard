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
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if (!($event instanceof BeforeTemplateRenderedEvent)) {
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

		Util::addScript('whiteboard', 'whiteboard-main');
		Util::addStyle('whiteboard', 'whiteboard-main');

		$this->initialState->provideInitialState('file_id', $node->getId());
		$this->initialState->provideInitialState('collabBackendUrl', $this->configService->getCollabBackendUrl());
		$this->initialState->provideInitialState('maxFileSize', $this->configService->getMaxFileSize());
	}
}
