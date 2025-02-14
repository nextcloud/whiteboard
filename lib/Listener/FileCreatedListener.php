<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Listener;

use OCA\Whiteboard\Service\ConfigService;
use OCA\Whiteboard\Service\StatsService;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Files\Events\Node\NodeCreatedEvent;
use OCP\IUserSession;

/** @template-implements IEventListener<NodeCreatedEvent|Event> */
/**
 * @psalm-suppress UndefinedClass
 * @psalm-suppress MissingTemplateParam
 */
final class FileCreatedListener implements IEventListener {
	public function __construct(
		protected StatsService $statsService,
		protected IUserSession $userSession,
		protected ConfigService $configService,
	) {
	}

	public function handle(Event $event): void {
		if (!($event instanceof NodeCreatedEvent) || !$this->configService->getWhiteboardEnableStatistics()) {
			return;
		}

		$node = $event->getNode();

		if ($node->getExtension() !== 'whiteboard') {
			return;
		}

		$currentUser = $this->userSession->getUser();
		$ownerUser = $node->getOwner();

		$this->statsService->insertEvent([
			'user' => $currentUser ? $currentUser->getUID() : ($ownerUser ? $ownerUser->getUID() : null),
			'type' => 'created',
			'share_token' => '',
			'fileid' => $node->getId(),
			'elements' => json_encode([]),
			'size' => 0,
			'timestamp' => time(),
		]);
	}
}
