<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Listener;

use OCA\Files_Versions\Events\VersionRestoredEvent;
use OCA\Whiteboard\Service\BoardStateStore;
use OCA\Whiteboard\Service\BoardSyncService;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Files\Events\Node\NodeWrittenEvent;
use OCP\Files\FileInfo;
use OCP\Server;

/**
 * Marks a board that someone else wrote or restored, also when the bytes end
 * up the same as before, so the next request starts a new epoch.
 *
 * @template-implements IEventListener<Event>
 * @psalm-suppress UndefinedClass VersionRestoredEvent exists from Nextcloud 32 on
 */
final class BoardOutsideWriteListener implements IEventListener {
	public function __construct(
		private BoardSyncService $boardSync,
		private BoardStateStore $states,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if ($event instanceof NodeWrittenEvent) {
			$this->flag($event->getNode());
		} elseif ($event instanceof VersionRestoredEvent) {
			$this->flag($event->getVersion()->getSourceFile());
		}
	}

	/**
	 * The `\OCP\Versions::rollback` hook, which Nextcloud 31 emits instead of the event
	 *
	 * @param array{node?: mixed} $params
	 * @psalm-suppress PossiblyUnusedMethod called by the hook
	 */
	public static function onRollback(array $params): void {
		$node = $params['node'] ?? null;
		if ($node instanceof FileInfo) {
			Server::get(self::class)->flag($node);
		}
	}

	private function flag(FileInfo $node): void {
		if ($node->getMimetype() !== 'application/vnd.excalidraw+json' || $this->boardSync->isWriting((int)$node->getId())) {
			return;
		}
		$this->states->flagOutsideWrite((int)$node->getId());
	}
}
