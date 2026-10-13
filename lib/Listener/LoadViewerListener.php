<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Listener;

use OCA\Whiteboard\Service\ConfigService;
use OCP\AppFramework\Http\Events\BeforeTemplateRenderedEvent;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\AppFramework\Services\IInitialState;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\IGroupManager;
use OCP\IUserSession;
use OCP\Util;

/** @template-implements IEventListener<BeforeTemplateRenderedEvent|Event> */
class LoadViewerListener implements IEventListener {
	public function __construct(
		private IInitialState $initialState,
		private ConfigService $configService,
		private IUserSession $userSession,
		private IGroupManager $groupManager,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		// The viewer is on every page, nothing on the error page opens a file.
		// Only registers the handler: the board loads when a whiteboard opens.
		if (!($event instanceof BeforeTemplateRenderedEvent)
			|| $event->getResponse()->getRenderAs() === TemplateResponse::RENDER_AS_ERROR) {
			return;
		}

		Util::addInitScript('whiteboard', 'whiteboard-viewer');

		$this->initialState->provideInitialState(
			'collabBackendUrl',
			$this->configService->getCollabBackendUrl()
		);
		$this->initialState->provideInitialState(
			'maxFileSize',
			$this->configService->getMaxFileSize()
		);
		$this->initialState->provideInitialState(
			'disableExternalLibraries',
			$this->configService->getDisableExternalLibraries()
		);
		$user = $this->userSession->getUser();
		$this->initialState->provideInitialState(
			'autoUploadOnDisconnect',
			$user ? $this->configService->getUserAutoUploadOnDisconnect($user->getUID()) : false
		);
		$this->initialState->provideInitialState(
			'isAdmin',
			$user !== null && $this->groupManager->isAdmin($user->getUID())
		);
		$this->initialState->provideInitialState('orgTemplatesSupported', Util::getVersion()[0] >= 30);
	}
}
