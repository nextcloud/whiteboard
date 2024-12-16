<?php

declare(strict_types=1);
/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
namespace OCA\Whiteboard\Listener;

use OCA\Whiteboard\Service\EventsService;
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
		protected EventsService $eventsService,
		protected IUserSession $userSession,
	) {
	}

	public function handle(Event $event): void {
		if (!($event instanceof NodeCreatedEvent)) {
			return;
		}

		$node = $event->getNode();

		if ($node->getExtension() !== 'whiteboard') {
			return;
		}

		$currentUser = $this->userSession->getUser();

		$this->eventsService->insertEvent([
			'user' => $currentUser ? $currentUser->getUID() : $node->getOwner()->getUID(),
			'type' => 'created',
			'share_token' => '',
			'fileid' => $node->getId(),
			'elements' => '',
			'size' => 0,
			'timestamp' => time(),
		]);
	}
}
