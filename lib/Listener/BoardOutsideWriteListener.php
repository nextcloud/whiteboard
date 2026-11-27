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
use OCP\Files\Events\Node\NodeDeletedEvent;
use OCP\Files\Events\Node\NodeWrittenEvent;
use OCP\Files\FileInfo;
use OCP\Files\NotFoundException;
use OCP\Server;

/**
 * Marks a board that someone else wrote or restored, also when the bytes end
 * up the same as before, so the next request starts a new epoch, and drops
 * the state of a deleted board.
 *
 * @template-implements IEventListener<Event>
 * @psalm-suppress UndefinedClass VersionRestoredEvent exists from Nextcloud 32 on
 */
final class BoardOutsideWriteListener implements IEventListener {
	public function __construct(
		private BoardStateStore $states,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if ($event instanceof NodeWrittenEvent) {
			$this->flag($event->getNode());
		} elseif ($event instanceof NodeDeletedEvent) {
			$fileId = $this->boardId($event->getNode());
			if ($fileId !== null) {
				$this->states->delete($fileId);
			}
		} elseif ($event instanceof VersionRestoredEvent) {
			$this->flag($event->getVersion()->getSourceFile(), true);
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
			Server::get(self::class)->flag($node, true);
		}
	}

	private function flag(FileInfo $node, bool $restore = false): void {
		$fileId = $this->boardId($node);
		if ($fileId !== null && !BoardSyncService::isWriting($fileId)) {
			$this->states->flagOutsideWrite($fileId, $restore);
		}
	}

	/**
	 * The file id of a board, or null for other files and for nodes without
	 * file information (Nextcloud's NonExistingFile throws then)
	 */
	private function boardId(FileInfo $node): ?int {
		try {
			return $node->getMimetype() === 'application/vnd.excalidraw+json' ? (int)$node->getId() : null;
		} catch (NotFoundException) {
			return null;
		}
	}
}
