<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Listener;

use OCA\Whiteboard\Events\WhiteboardOpenedEvent;
use OCA\Whiteboard\Model\PublicSharingUser;
use OCA\Whiteboard\Service\ConfigService;
use OCA\Whiteboard\Service\StatsService;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;

/** @template-implements IEventListener<WhiteboardOpenedEvent|Event> */
/**
 * @psalm-suppress UndefinedClass
 * @psalm-suppress MissingTemplateParam
 */
final class WhiteboardOpenedListener implements IEventListener {
	public function __construct(
		protected StatsService $statsService,
		protected ConfigService $configService,
	) {
	}

	public function handle(Event $event): void {
		if (!($event instanceof WhiteboardOpenedEvent) || !$this->configService->getWhiteboardEnableStatistics()) {
			return;
		}

		$user = $event->getUser();
		$file = $event->getFile();
		$data = $event->getData();

		$this->statsService->insertEvent([
			'user' => $user->getUID(),
			'type' => 'opened',
			'share_token' => $user instanceof PublicSharingUser ? $user->getPublicSharingToken() : '',
			'fileid' => $file->getId(),
			'elements' => count($data['elements']),
			'size' => $file->getSize(),
			'timestamp' => time(),
		]);
	}
}
