<?php

declare(strict_types=1);
/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
namespace OCA\Whiteboard\Listener;

use OCA\Whiteboard\Events\WhiteboardOpenedEvent;
use OCA\Whiteboard\Model\PublicSharingUser;
use OCA\Whiteboard\Service\EventsService;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Files\Events\Node\NodeCreatedEvent;

/** @template-implements IEventListener<NodeCreatedEvent|Event> */
/**
 * @psalm-suppress UndefinedClass
 * @psalm-suppress MissingTemplateParam
 */
final class WhiteboardOpenedListener implements IEventListener {
    public function __construct(
        protected EventsService $eventsService,
    ) {
    }

    public function handle(Event $event): void {
        if (!($event instanceof WhiteboardOpenedEvent)) {
            return;
        }

        $user = $event->getUser();
        $file = $event->getFile();
        $data = $event->getData();

        $this->eventsService->insertEvent([
            'user' => $user->getUID(),
            'type' => 'opened',
            'share_token' => $user instanceof PublicSharingUser ? $user->getPublicSharingToken() : '',
            'fileid' => $file->getId(),
            'elements' => $data['elements'] ?? '',
            'size' => $file->getSize(),
            'timestamp' => time(),
        ]);
    }
}
