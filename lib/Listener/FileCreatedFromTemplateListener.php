<?php

declare(strict_types=1);
/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
namespace OCA\Whiteboard\Listener;

use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Files\File;
use OCP\Files\Template\FileCreatedFromTemplateEvent;
use Psr\Log\LoggerInterface;

/** @template-implements IEventListener<FileCreatedFromTemplateEvent|Event> */
/**
 * @psalm-suppress MissingTemplateParam
 */
final class FileCreatedFromTemplateListener implements IEventListener {
	private const LIB_EXTENSION = '.excalidrawlib';
	private const WHITEBOARD_EXTENSION = '.whiteboard';
	private const VOLATILE_ELEMENT_KEYS = [
		'id' => true,
		'seed' => true,
		'version' => true,
		'versionNonce' => true,
		'updated' => true,
		'index' => true,
		'groupIds' => true,
		'frameId' => true,
		'boundElements' => true,
		'containerId' => true,
	];

	public function __construct(
		private LoggerInterface $logger,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if (!($event instanceof FileCreatedFromTemplateEvent)) {
			return;
		}

		$template = $event->getTemplate();
		$target = $event->getTarget();
		if (!($template instanceof File)) {
			return;
		}

		if (!$this->isLibraryTemplate($template) || !$this->isWhiteboardTarget($target)) {
			return;
		}

		$libraryItems = $this->parseLibraryItems($template);
		if ($libraryItems === []) {
			return;
		}

		try {
			$target->putContent(json_encode([
				'elements' => [],
				'files' => [],
				'libraryItems' => $libraryItems,
				'scrollToContent' => true,
			], JSON_THROW_ON_ERROR));
		} catch (\Throwable $e) {
			$this->logger->warning('Failed to normalize whiteboard created from library template', [
				'app' => 'whiteboard',
				'template' => $template->getPath(),
				'target' => $target->getPath(),
				'exception' => $e,
			]);
		}
	}

	private function isLibraryTemplate(File $file): bool {
		return str_ends_with(strtolower($file->getName()), self::LIB_EXTENSION);
	}

	private function isWhiteboardTarget(File $file): bool {
		return str_ends_with(strtolower($file->getName()), self::WHITEBOARD_EXTENSION);
	}

	private function parseLibraryItems(File $file): array {
		try {
			$data = json_decode($file->getContent(), true, 512, JSON_THROW_ON_ERROR);
		} catch (\Throwable) {
			return [];
		}

		if (!is_array($data)) {
			return [];
		}

		if (isset($data['libraryItems']) && is_array($data['libraryItems'])) {
			return $this->normalizeLibraryItems($data['libraryItems']);
		}

		if (isset($data['library']) && is_array($data['library'])) {
			$items = [];
			foreach ($data['library'] as $elements) {
				if (!is_array($elements) || count($elements) === 0) {
					continue;
				}
				$items[] = [
					'id' => $this->createLibraryItemId($elements),
					'elements' => array_values($elements),
					'status' => 'published',
				];
			}
			return $this->normalizeLibraryItems($items);
		}

		return [];
	}

	private function normalizeLibraryItems(array $items): array {
		$normalized = [];
		$seen = [];

		foreach ($items as $item) {
			if (!is_array($item) || !isset($item['elements']) || !is_array($item['elements']) || count($item['elements']) === 0) {
				continue;
			}

			unset($item['templateName'], $item['scope'], $item['filename'], $item['basename']);
			$item['elements'] = array_values($item['elements']);
			$key = $this->createLibraryItemId($item['elements']);
			if (isset($seen[$key])) {
				continue;
			}
			$seen[$key] = true;

			$item['id'] = isset($item['id']) && is_string($item['id']) && $item['id'] !== ''
				? $item['id']
				: $key;
			$item['created'] = isset($item['created']) && is_numeric($item['created'])
				? (int)$item['created']
				: $this->nowMs();
			$item['status'] = isset($item['status']) && is_string($item['status'])
				? $item['status']
				: 'unpublished';

			$normalized[] = $item;
		}

		return $normalized;
	}

	private function createLibraryItemId(array $elements): string {
		$canonicalElements = $this->canonicalizeLibraryValue($elements);
		$encoded = json_encode($canonicalElements);
		return substr(hash('sha256', $encoded !== false ? $encoded : serialize($canonicalElements)), 0, 20);
	}

	private function canonicalizeLibraryValue(mixed $value): mixed {
		if (!is_array($value)) {
			return $value;
		}

		if (array_is_list($value)) {
			return array_map(fn ($item) => $this->canonicalizeLibraryValue($item), $value);
		}

		ksort($value);
		$normalized = [];
		foreach ($value as $key => $item) {
			if (is_string($key) && isset(self::VOLATILE_ELEMENT_KEYS[$key])) {
				continue;
			}
			$normalized[$key] = $this->canonicalizeLibraryValue($item);
		}
		return $normalized;
	}

	private function nowMs(): int {
		return (int)floor(microtime(true) * 1000);
	}
}
