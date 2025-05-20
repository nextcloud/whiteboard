<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */


namespace OCA\Whiteboard\Listener;

use OCA\Viewer\Event\LoadViewer;
use OCA\Whiteboard\Service\ConfigService;
use OCA\Whiteboard\Service\ExAppService;
use OCP\AppFramework\Services\IInitialState;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Util;

/** @template-implements IEventListener<LoadViewer|Event> */
class LoadViewerListener implements IEventListener {
	public function __construct(
		private IInitialState $initialState,
		private ConfigService $configService,
		private ExAppService $exAppService,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if (!($event instanceof LoadViewer)) {
			return;
		}

		Util::addScript('whiteboard', 'whiteboard-main');
		Util::addStyle('whiteboard', 'whiteboard-main');

		$this->initialState->provideInitialState(
			'collabBackendUrl',
			$this->configService->getCollabBackendUrl()
		);
		$this->initialState->provideInitialState(
			'maxFileSize',
			$this->configService->getMaxFileSize()
		);

		// Initialize ExApp frontend state
		$this->exAppService->initFrontendState();
	}
}
