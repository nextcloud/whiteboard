<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use JsonException;
use OCA\Whiteboard\Model\PublicSharingUser;
use OCA\Whiteboard\Model\User;
use OCP\Files\File;
use OCP\Files\GenericFileException;
use OCP\Files\NotPermittedException;
use OCP\Lock\LockedException;
use Psr\Log\LoggerInterface;

final class WhiteboardContentService {
	private const CREATOR_PROOF_DOMAIN = 'whiteboard.creator.v1';
	// Settings of the whole board that every tab shows the same; the last one saved wins
	private const BOARD_SETTINGS = ['viewBackgroundColor', 'gridSize', 'gridStep'];
	// Clients count revisions in JavaScript numbers, which are exact up to 2^53
	private const MAX_REVISION = 2 ** 53 - 2;
	// A new epoch starts above the revisions in the file only up to here, so later saves stay countable
	private const MAX_START_REVISION = 2 ** 52;
	// JavaScript's Number.MAX_SAFE_INTEGER
	private const MAX_SAFE_INTEGER = 2 ** 53 - 1;
	private const CREATOR_PROOF_PREFIX = 'v1:';
	// As in Excalidraw's collaboration: a deleted element is kept this long after Nextcloud stored its deletion, so a tab that missed it cannot bring it back
	private const DELETED_ELEMENT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

	private string $creatorSecret;

	public function __construct(
		private LoggerInterface $logger,
		ConfigService $configService,
	) {
		$this->creatorSecret = $configService->getJwtSecretKey();
	}

	/**
	 * The board in the stored bytes; blank bytes are an empty board
	 *
	 * @return array<string,mixed>
	 * @throws JsonException when the bytes are not a board
	 */
	public function decode(string $bytes): array {
		// Some object stores create new files with a single space
		if (trim($bytes, " \t\r\n") === '') {
			return ['elements' => [], 'scrollToContent' => true];
		}

		$board = json_decode($bytes, true, 512, JSON_THROW_ON_ERROR);
		// A JSON list is no board either, though PHP decodes it to an array
		if (!is_array($board) || ($board !== [] && array_is_list($board))) {
			throw new JsonException('The board is not a JSON object');
		}
		return $board;
	}

	/**
	 * @param array<string,mixed> $board
	 * @throws JsonException
	 */
	public function encode(array $board): string {
		return json_encode($board, JSON_THROW_ON_ERROR);
	}

	/**
	 * Merges elements and files into the stored board by Excalidraw's order: an
	 * element replaces the stored copy only with a higher version, or an equal
	 * version and a lower nonce. Elements missing from the request stay as
	 * they are; files are added under new ids only; board settings take the
	 * sent value, unless the setting changed after revision `$since`, which the
	 * sender did not know. Each changed element, file and setting gets the revision `$rev`;
	 * stored revisions from `$rev` up were written elsewhere and are dropped.
	 * A board that changes drops the elements whose deletion Nextcloud stored
	 * more than a day ago and the images no element uses, unless this save
	 * sent them. It notes the latest revision of the elements it drops, as no
	 * delta from before it can tell they are gone.
	 *
	 * @param array<string,mixed> $stored decoded board
	 * @param array<mixed> $elements
	 * @param array<mixed> $files
	 * @param array<mixed> $settings
	 * @return array{board: array<string,mixed>, elements: list<string>, files: list<string>, settings: list<string>}
	 */
	public function merge(array $stored, array $elements, array $files, User $actor, int $fileId, int $rev, array $settings = [], int $since = PHP_INT_MAX): array {
		$board = $this->normalizeStoredData($stored);
		$byId = $this->indexElementsById($board['elements']);
		$actorInfo = $this->buildActorInfo($actor, $this->getCurrentTimeInMilliseconds());
		$changedElements = [];

		// A request may carry several copies of an element; the one that wins counts
		$incomingById = [];
		foreach ($this->sanitizeElements($elements) as $incoming) {
			$elementId = $this->getElementId($incoming);
			if ($elementId !== null && (!isset($incomingById[$elementId]) || $this->wins($incoming, $incomingById[$elementId]))) {
				$incomingById[$elementId] = $incoming;
			}
		}

		foreach ($incomingById as $incoming) {
			// Array keys turn numeric ids into integers
			$elementId = (string)$this->getElementId($incoming);
			$storedElement = $byId[$elementId] ?? null;
			if ($storedElement !== null && !$this->wins($incoming, $storedElement)) {
				continue;
			}

			$merged = $this->stripCreatorMetadata($incoming);
			if ($storedElement !== null) {
				$storedCreator = $this->getCreator($storedElement);
				if ($storedCreator !== null) {
					$merged = $this->setCreator($merged, $storedCreator, $this->getValidCreatorProof($fileId, $elementId, $storedElement, $storedCreator));
				}
			} else {
				$incomingCreator = $this->getCreator($incoming);
				$proof = $incomingCreator !== null ? $this->getValidCreatorProof($fileId, $elementId, $incoming, $incomingCreator) : null;
				$merged = $proof !== null && $incomingCreator !== null
					? $this->setCreator($merged, $incomingCreator, $proof)
					: $this->setCreator($merged, $actorInfo, $this->createCreatorProof($fileId, $elementId, $actorInfo));
			}
			$byId[$elementId] = $merged;
			$changedElements[$elementId] = true;
		}

		$changedFiles = [];
		foreach ($this->sanitizeFiles($files) as $id => $file) {
			if (!isset($board['files'][$id])) {
				$board['files'][$id] = $file;
				$changedFiles[(string)$id] = true;
			}
		}

		$changedSettings = [];
		$revisions = $this->getRevisions($stored, $rev - 1);
		$settingRevisions = $revisions['settings'];
		foreach ($this->sanitizeSettings($settings) as $key => $value) {
			if (($settingRevisions[$key] ?? 0) > $since) {
				continue;
			}
			if (!array_key_exists($key, $board['appState'] ?? []) || $board['appState'][$key] !== $value) {
				$board['appState'][$key] = $value;
				$changedSettings[] = $key;
			}
		}

		if ($changedElements === [] && $changedFiles === [] && $changedSettings === []) {
			return ['board' => $stored, 'elements' => [], 'files' => [], 'settings' => []];
		}

		// When Nextcloud stored each deletion, by its own clock; one it has no time for counts from now
		$now = $this->getCurrentTimeInMilliseconds();
		$deletedAt = [];
		foreach ($byId as $id => $element) {
			if (($element['isDeleted'] ?? false) === true) {
				$deletedAt[(string)$id] = $revisions['deletedAt'][(string)$id] ?? $now;
			}
		}
		$kept = array_filter($byId, static fn (string|int $id): bool => isset($changedElements[(string)$id])
			|| ($deletedAt[(string)$id] ?? $now) > $now - self::DELETED_ELEMENT_TIMEOUT_MS, ARRAY_FILTER_USE_KEY);
		foreach (array_keys(array_diff_key($byId, $kept)) as $id) {
			$revisions['pruned'] = max($revisions['pruned'], $revisions['elements'][(string)$id] ?? 0);
		}
		$byId = $kept;
		$used = $this->fileIdsOf([...array_values($byId), ...array_merge(...array_column($board['libraryItems'] ?? [], 'elements'))]);
		$board['files'] = array_filter($board['files'], static fn (string|int $id): bool => isset($changedFiles[(string)$id]) || isset($used[(string)$id]), ARRAY_FILTER_USE_KEY);

		// Stored elements keep their place, new ones follow
		$board['elements'] = $this->orderElements(array_values($byId));
		ksort($board['files']);
		$revisions['elements'] = array_intersect_key($revisions['elements'], $byId);
		$revisions['files'] = array_intersect_key($revisions['files'], $board['files']);
		$revisions['deletedAt'] = array_intersect_key($deletedAt, $byId);
		$board['revisions'] = $revisions;
		foreach (array_keys($changedElements) as $id) {
			$board['revisions']['elements'][$id] = $rev;
		}
		foreach (array_keys($changedFiles) as $id) {
			$board['revisions']['files'][$id] = $rev;
		}
		foreach ($changedSettings as $key) {
			$board['revisions']['settings'][$key] = $rev;
		}

		return ['board' => $board, 'elements' => array_map('strval', array_keys($changedElements)), 'files' => array_map('strval', array_keys($changedFiles)), 'settings' => $changedSettings];
	}

	/**
	 * The elements, files and board settings changed after revision `$since`,
	 * or null when the board dropped deleted elements that changed after it
	 *
	 * @param array<string,mixed> $board decoded board
	 * @param int $rev the revision of the board; higher ones in it were written elsewhere
	 * @return array{elements: list<array<string,mixed>>, files: array<string,mixed>, settings: array<string,mixed>}|null
	 */
	public function changesSince(array $board, int $since, int $rev): ?array {
		$revisions = $this->getRevisions($board, $rev);
		if ($since < $revisions['pruned']) {
			return null;
		}
		$elements = [];
		foreach ($board['elements'] ?? [] as $element) {
			$elementId = is_array($element) ? $this->getElementId($element) : null;
			if ($elementId !== null && ($revisions['elements'][$elementId] ?? 0) > $since) {
				$elements[] = $element;
			}
		}
		$files = [];
		foreach (is_array($board['files'] ?? null) ? $board['files'] : [] as $id => $file) {
			if (($revisions['files'][$id] ?? 0) > $since) {
				$files[$id] = $file;
			}
		}
		$settings = [];
		foreach ($this->sanitizeSettings(is_array($board['appState'] ?? null) ? $board['appState'] : []) as $key => $value) {
			if (($revisions['settings'][$key] ?? 0) > $since) {
				$settings[$key] = $value;
			}
		}
		return ['elements' => $elements, 'files' => $files, 'settings' => $settings];
	}

	/**
	 * The board as clients read it: always with an element list, never with
	 * revisions
	 *
	 * @param array<string,mixed> $board
	 * @return array<string,mixed>
	 */
	public function forClient(array $board): array {
		return $this->normalizeStoredData($board);
	}

	/**
	 * @param array<string,mixed> $board
	 */
	public function latestRevision(array $board): int {
		$revisions = $this->getRevisions($board);
		$all = [...array_values($revisions['elements']), ...array_values($revisions['files']), ...array_values($revisions['settings'])];
		return max([$revisions['pruned'], ...array_filter($all, static fn (int $rev): bool => $rev <= self::MAX_START_REVISION)]);
	}

	/**
	 * @param array<string,mixed> $board
	 * @return array{elements: array<string,int>, files: array<string,int>, settings: array<string,int>, deletedAt: array<string,int>, pruned: int}
	 */
	private function getRevisions(array $board, int $upTo = self::MAX_REVISION): array {
		// A file written elsewhere may carry any number
		$valid = static fn (mixed $value, int $max): bool => is_int($value) && $value >= 0 && $value <= $max;
		$revisions = ['elements' => [], 'files' => [], 'settings' => [], 'deletedAt' => []];
		foreach (['elements', 'files', 'settings', 'deletedAt'] as $kind) {
			// Deletion times are clock times, not revisions
			$max = $kind === 'deletedAt' ? self::MAX_REVISION : min($upTo, self::MAX_REVISION);
			foreach (is_array($board['revisions'][$kind] ?? null) ? $board['revisions'][$kind] : [] as $id => $rev) {
				if ($valid($rev, $max)) {
					$revisions[$kind][(string)$id] = $rev;
				}
			}
		}
		// An epoch starts at or above the dropped deletions, so no client of it is behind them
		$pruned = $board['revisions']['pruned'] ?? 0;
		return $revisions + ['pruned' => $valid($pruned, min($upTo, self::MAX_START_REVISION)) ? $pruned : 0];
	}

	/**
	 * The images that elements on the board show and the board lacks, so the
	 * tabs that have them send them again
	 *
	 * @param array<string,mixed> $board decoded board
	 * @return list<string>
	 */
	public function missingFiles(array $board): array {
		$live = array_filter(is_array($board['elements'] ?? null) ? $board['elements'] : [], static fn (mixed $element): bool => is_array($element) && ($element['isDeleted'] ?? false) !== true);
		$files = is_array($board['files'] ?? null) ? $board['files'] : [];
		return array_map('strval', array_keys(array_diff_key($this->fileIdsOf($live), $files)));
	}

	/**
	 * The ids of the images the elements show
	 *
	 * @param array<mixed> $elements
	 * @return array<string,true>
	 */
	private function fileIdsOf(array $elements): array {
		$ids = [];
		foreach ($elements as $element) {
			if (is_array($element) && is_string($element['fileId'] ?? null)) {
				$ids[$element['fileId']] = true;
			}
		}
		return $ids;
	}

	/**
	 * Excalidraw's order: higher version, then lower nonce
	 *
	 * @param array<string,mixed> $incoming
	 * @param array<string,mixed> $stored
	 */
	private function wins(array $incoming, array $stored): bool {
		if ($incoming['version'] !== $stored['version']) {
			return $incoming['version'] > $stored['version'];
		}
		return $incoming['versionNonce'] < $stored['versionNonce'];
	}

	/**
	 * A safe integer, from an integer, an integral number or a string of
	 * digits, or null
	 */
	private function safeInteger(mixed $value): ?int {
		if (is_string($value) && preg_match('/^-?\d+$/', $value) === 1) {
			$value = (int)$value;
		} elseif (is_float($value) && floor($value) === $value && abs($value) <= self::MAX_SAFE_INTEGER) {
			$value = (int)$value;
		}
		return is_int($value) && abs($value) <= self::MAX_SAFE_INTEGER ? $value : null;
	}

	/**
	 * Orders elements by fractional index and id, as Excalidraw does, when
	 * every element has an index; older boards keep their order
	 *
	 * @param list<array<string,mixed>> $elements
	 * @return list<array<string,mixed>>
	 */
	private function orderElements(array $elements): array {
		foreach ($elements as $element) {
			if (!is_string($element['index'] ?? null)) {
				return $elements;
			}
		}
		usort($elements, static fn (array $a, array $b): int => strcmp($a['index'], $b['index']) ?: strcmp((string)$a['id'], (string)$b['id']));
		return $elements;
	}

	/**
	 * @throws NotPermittedException
	 * @throws GenericFileException
	 * @throws LockedException
	 * @throws JsonException
	 */
	public function getContent(File $file): array {
		$fileContent = $file->getContent();
		// Some object stores create new files with a single space
		if (trim($fileContent, " \t\r\n") === '') {
			$fileContent = '{"elements":[],"scrollToContent":true}';
		}

		return json_decode($fileContent, true, 512, JSON_THROW_ON_ERROR);
	}

	/**
	 * @throws NotPermittedException
	 * @throws GenericFileException
	 * @throws LockedException
	 * @throws JsonException
	 */
	public function updateContent(File $file, array $data, User $actor): void {
		$fileId = $file->getId();
		$incoming = $this->normalizeIncomingData($data);

		if ($this->isEffectivelyEmptyPayload($incoming)) {
			$this->logger->debug('Skipping whiteboard save because payload is empty', [
				'app' => 'whiteboard',
				'fileId' => $fileId,
			]);
			return;
		}

		try {
			$current = $this->normalizeStoredData($this->getContent($file));
		} catch (JsonException $e) {
			$this->logger->warning('Existing whiteboard content is invalid JSON, resetting to defaults', [
				'app' => 'whiteboard',
				'fileId' => $fileId,
				'error' => $e->getMessage(),
			]);
			$current = $this->normalizeStoredData([]);
		}

		$actorInfo = $this->buildActorInfo($actor, $this->getCurrentTimeInMilliseconds());
		$merged = $this->mergeData($current, $incoming, $actorInfo, $fileId);

		$canonicalCurrent = $this->canonicalize($current);
		$canonicalMerged = $this->canonicalize($merged);

		if ($canonicalCurrent === $canonicalMerged || $this->hasSameElementVersions($canonicalCurrent, $canonicalMerged)) {
			$this->logger->debug('Skipping whiteboard save because payload matches stored content', [
				'app' => 'whiteboard',
				'fileId' => $fileId,
			]);
			return;
		}

		try {
			$encodedPayload = json_encode($canonicalMerged, JSON_THROW_ON_ERROR);
		} catch (JsonException $e) {
			$this->logger->error('Failed to encode whiteboard content before saving', [
				'app' => 'whiteboard',
				'fileId' => $fileId,
				'error' => $e->getMessage(),
			]);
			throw $e;
		}

		$maxRetries = 3;
		$baseDelay = 1000000; // 1 second

		for ($attempt = 0; $attempt < $maxRetries; $attempt++) {
			try {
				$file->putContent($encodedPayload);
				return;
			} catch (LockedException $e) {
				if ($attempt === $maxRetries - 1) {
					$this->logger->error('Whiteboard file write failed after retries', [
						'app' => 'whiteboard',
						'fileId' => $fileId,
						'error' => $e->getMessage(),
					]);
					throw $e;
				}

				$delay = (int)($baseDelay * ((int)(2 ** $attempt)));
				$this->logger->warning('Whiteboard file locked, retrying', [
					'app' => 'whiteboard',
					'fileId' => $fileId,
					'attempt' => $attempt + 1,
				]);

				usleep($delay);
			}
		}
	}

	/**
	 * @return array<string,mixed>
	 */
	private function getEmptyState(): array {
		return [
			'elements' => [],
			'files' => [],
			'scrollToContent' => true,
		];
	}

	/**
	 * @param array<string,mixed> $payload
	 *
	 * @return array<string,mixed>
	 */
	private function unwrapData(array $payload): array {
		if (array_key_exists('data', $payload) && is_array($payload['data'])) {
			return $payload['data'];
		}

		return $payload;
	}

	/**
	 * @param array<string,mixed> $incoming
	 *
	 * @return array<string,mixed>
	 */
	private function normalizeIncomingData(array $incoming): array {
		$incoming = $this->unwrapData($incoming);

		if (empty($incoming)) {
			return $this->getEmptyState();
		}

		$normalized = [];

		if (array_key_exists('elements', $incoming) && is_array($incoming['elements'])) {
			$normalized['elements'] = $this->sanitizeElements($incoming['elements']);
		}

		if (array_key_exists('files', $incoming)) {
			$normalized['files'] = is_array($incoming['files'])
				? $this->sanitizeFiles($incoming['files'])
				: [];
		}

		if (array_key_exists('libraryItems', $incoming) && is_array($incoming['libraryItems'])) {
			$normalized['libraryItems'] = $this->sanitizeLibraryItems($incoming['libraryItems']);
		}

		if (array_key_exists('appState', $incoming) && is_array($incoming['appState'])) {
			$normalized['appState'] = $this->sanitizeAppState($incoming['appState']);
		}

		if (array_key_exists('scrollToContent', $incoming)) {
			$normalized['scrollToContent'] = (bool)$incoming['scrollToContent'];
		}

		if (array_key_exists('libraryRef', $incoming)) {
			if ($incoming['libraryRef'] === null) {
				// Explicit removal marker; mergeData() drops the stored ref.
				$normalized['libraryRef'] = null;
			} else {
				$ref = $this->sanitizeLibraryRef($incoming['libraryRef']);
				if ($ref !== null) {
					$normalized['libraryRef'] = $ref;
				}
			}
		}

		return $normalized;
	}

	/**
	 * @param array<string,mixed> $payload
	 */
	private function isEffectivelyEmptyPayload(array $payload): bool {
		if (array_key_exists('libraryItems', $payload)) {
			return false;
		}

		$hasFiles = array_key_exists('files', $payload)
			&& is_array($payload['files'])
			&& !empty($payload['files']);

		if ($hasFiles) {
			return false;
		}

		$hasAppState = array_key_exists('appState', $payload)
			&& is_array($payload['appState'])
			&& !empty($payload['appState']);

		if ($hasAppState) {
			return false;
		}

		if (array_key_exists('scrollToContent', $payload) && $payload['scrollToContent'] !== true) {
			return false;
		}

		if (!array_key_exists('elements', $payload) || !is_array($payload['elements'])) {
			return false;
		}

		if (!empty($payload['elements'])) {
			return false;
		}

		foreach ($payload as $key => $_value) {
			if (!in_array($key, ['elements', 'files', 'libraryItems', 'appState', 'scrollToContent'], true)) {
				return false;
			}
		}

		return true;
	}

	/**
	 * @param array<string,mixed> $stored
	 *
	 * @return array<string,mixed>
	 */
	private function normalizeStoredData(array $stored): array {
		$stored = $this->unwrapData($stored);

		// Excalidraw only opens files that carry its type marker
		$normalized = ['type' => 'excalidraw', 'version' => 2] + $this->getEmptyState();
		if (is_string($stored['source'] ?? null)) {
			$normalized['source'] = $stored['source'];
		}

		if (empty($stored)) {
			return $normalized;
		}

		if (array_key_exists('elements', $stored) && is_array($stored['elements'])) {
			$normalized['elements'] = $this->sanitizeElements($stored['elements']);
		}

		if (array_key_exists('files', $stored) && is_array($stored['files'])) {
			$normalized['files'] = $this->sanitizeFiles($stored['files']);
		}

		if (array_key_exists('libraryItems', $stored) && is_array($stored['libraryItems'])) {
			$normalized['libraryItems'] = $this->sanitizeLibraryItems($stored['libraryItems']);
		}

		if (array_key_exists('appState', $stored) && is_array($stored['appState'])) {
			$normalized['appState'] = $this->sanitizeAppState($stored['appState']);
		}

		if (array_key_exists('scrollToContent', $stored)) {
			$normalized['scrollToContent'] = (bool)$stored['scrollToContent'];
		}

		if (array_key_exists('libraryRef', $stored)) {
			$ref = $this->sanitizeLibraryRef($stored['libraryRef']);
			if ($ref !== null) {
				$normalized['libraryRef'] = $ref;
			}
		}

		return $normalized;
	}

	/**
	 * @param array<string,mixed> $current
	 * @param array<string,mixed> $incoming
	 * @param array{uid:string,displayName:string,createdAt:int} $actorInfo
	 *
	 * @return array<string,mixed>
	 */
	private function mergeData(array $current, array $incoming, array $actorInfo, int $fileId): array {
		$merged = $current;

		if (array_key_exists('elements', $incoming)) {
			$merged['elements'] = $this->mergeElements(
				$current['elements'] ?? [],
				$incoming['elements'],
				$actorInfo,
				$fileId,
			);
		}

		if (array_key_exists('files', $incoming)) {
			$merged['files'] = $incoming['files'];
		}

		if (array_key_exists('libraryItems', $incoming)) {
			$merged['libraryItems'] = $incoming['libraryItems'];
		}

		if (array_key_exists('appState', $incoming)) {
			if ($incoming['appState'] === null) {
				unset($merged['appState']);
			} else {
				$merged['appState'] = $incoming['appState'];
			}
		}

		if (array_key_exists('scrollToContent', $incoming)) {
			$merged['scrollToContent'] = (bool)$incoming['scrollToContent'];
		}

		if (array_key_exists('libraryRef', $incoming)) {
			if ($incoming['libraryRef'] === null) {
				unset($merged['libraryRef']);
			} else {
				$ref = $this->sanitizeLibraryRef($incoming['libraryRef']);
				if ($ref !== null) {
					$merged['libraryRef'] = $ref;
				}
			}
		}

		return $merged;
	}

	/**
	 * @param array<int,mixed> $currentElements
	 * @param array<int,mixed> $incomingElements
	 * @param array{uid:string,displayName:string,createdAt:int} $actorInfo
	 *
	 * @return array<int,mixed>
	 */
	private function mergeElements(array $currentElements, array $incomingElements, array $actorInfo, int $fileId): array {
		$currentElementsById = $this->indexElementsById($currentElements);
		$mergedElements = [];
		$seenElementIds = [];

		foreach ($incomingElements as $incomingElement) {
			if (!is_array($incomingElement)) {
				continue;
			}

			$elementId = $this->getElementId($incomingElement);
			if ($elementId !== null && isset($seenElementIds[$elementId])) {
				$this->logger->warning('Skipping duplicate whiteboard element ID', [
					'app' => 'whiteboard',
					'fileId' => $fileId,
					'elementId' => $elementId,
				]);
				continue;
			}
			if ($elementId !== null) {
				$seenElementIds[$elementId] = true;
			}

			$storedElement = $elementId !== null ? ($currentElementsById[$elementId] ?? null) : null;
			$incomingCreator = $this->getCreator($incomingElement);
			$mergedElement = $this->stripCreatorMetadata($incomingElement);

			if ($storedElement !== null && $elementId !== null) {
				$storedCreator = $this->getCreator($storedElement);
				if ($storedCreator !== null) {
					$storedProof = $this->getValidCreatorProof($fileId, $elementId, $storedElement, $storedCreator);
					$mergedElement = $this->setCreator($mergedElement, $storedCreator, $storedProof);
				}
				$mergedElements[] = $mergedElement;
				continue;
			}

			$validProof = $incomingCreator !== null && $elementId !== null
				? $this->getValidCreatorProof($fileId, $elementId, $incomingElement, $incomingCreator)
				: null;
			if ($validProof !== null && $incomingCreator !== null) {
				$creator = $incomingCreator;
				$proof = $validProof;
			} else {
				$creator = $actorInfo;
				$proof = $elementId !== null ? $this->createCreatorProof($fileId, $elementId, $creator) : null;
			}
			$mergedElements[] = $this->setCreator($mergedElement, $creator, $proof);
		}

		return $mergedElements;
	}

	/**
	 * @param array<int,mixed> $elements
	 *
	 * @return array<string,array<string,mixed>>
	 */
	private function indexElementsById(array $elements): array {
		$indexed = [];
		foreach ($elements as $element) {
			if (!is_array($element)) {
				continue;
			}
			$elementId = $this->getElementId($element);
			if ($elementId !== null && !isset($indexed[$elementId])) {
				$indexed[$elementId] = $element;
			}
		}
		return $indexed;
	}

	/**
	 * @param array<string,mixed> $element
	 */
	private function getElementId(array $element): ?string {
		return isset($element['id']) && is_string($element['id']) && $element['id'] !== ''
			? $element['id']
			: null;
	}

	/**
	 * @param array<string,mixed> $element
	 *
	 * @return array{uid:string,displayName:string,createdAt:int}|null
	 */
	private function getCreator(array $element): ?array {
		if (!isset($element['customData']) || !is_array($element['customData'])) {
			return null;
		}

		$creator = $element['customData']['creator'] ?? null;
		if (!is_array($creator)
			|| !isset($creator['uid'], $creator['displayName'], $creator['createdAt'])
			|| !is_string($creator['uid'])
			|| $creator['uid'] === ''
			|| !is_string($creator['displayName'])
			|| !is_int($creator['createdAt'])
			|| $creator['createdAt'] <= 0) {
			return null;
		}

		return [
			'uid' => $creator['uid'],
			'displayName' => $creator['displayName'],
			'createdAt' => $creator['createdAt'],
		];
	}

	/**
	 * @param array<string,mixed> $element
	 *
	 * @return array<string,mixed>
	 */
	private function stripCreatorMetadata(array $element): array {
		if (!isset($element['customData']) || !is_array($element['customData'])) {
			return $element;
		}

		unset($element['customData']['creator'], $element['customData']['creatorProof']);
		if ($element['customData'] === []) {
			unset($element['customData']);
		}
		return $element;
	}

	/**
	 * @param array<string,mixed> $element
	 * @param array{uid:string,displayName:string,createdAt:int} $creator
	 *
	 * @return array<string,mixed>
	 */
	private function setCreator(array $element, array $creator, ?string $proof): array {
		if (!isset($element['customData']) || !is_array($element['customData'])) {
			$element['customData'] = [];
		}
		$element['customData']['creator'] = $creator;
		if ($proof !== null) {
			$element['customData']['creatorProof'] = $proof;
		}
		return $element;
	}

	/**
	 * @param array<string,mixed> $element
	 * @param array{uid:string,displayName:string,createdAt:int} $creator
	 */
	private function getValidCreatorProof(int $fileId, string $elementId, array $element, array $creator): ?string {
		$proof = $element['customData']['creatorProof'] ?? null;
		if (!is_string($proof)
			|| preg_match('/^v1:[a-f0-9]{64}$/D', $proof) !== 1
			|| !hash_equals($this->createCreatorProof($fileId, $elementId, $creator), $proof)) {
			return null;
		}
		return $proof;
	}

	/**
	 * @param array{uid:string,displayName:string,createdAt:int} $creator
	 */
	private function createCreatorProof(int $fileId, string $elementId, array $creator): string {
		$payload = implode('.', [
			self::CREATOR_PROOF_DOMAIN,
			$this->base64UrlEncode((string)$fileId),
			$this->base64UrlEncode($elementId),
			$this->base64UrlEncode($creator['uid']),
			$this->base64UrlEncode($creator['displayName']),
			(string)$creator['createdAt'],
		]);
		return self::CREATOR_PROOF_PREFIX . hash_hmac('sha256', $payload, $this->creatorSecret);
	}

	private function base64UrlEncode(string $value): string {
		return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
	}

	/**
	 * @return array{uid:string,displayName:string,createdAt:int}
	 */
	private function buildActorInfo(User $actor, int $createdAt): array {
		if ($actor instanceof PublicSharingUser) {
			return [
				'uid' => 'public-link:' . substr(hash('sha256', $actor->getPublicSharingToken()), 0, 16),
				'displayName' => 'Public link',
				'createdAt' => $createdAt,
			];
		}

		$uid = $actor->getUID();
		$displayName = $actor->getDisplayName();
		return [
			'uid' => $uid,
			'displayName' => $displayName !== '' ? $displayName : $uid,
			'createdAt' => $createdAt,
		];
	}

	private function getCurrentTimeInMilliseconds(): int {
		return (int)floor((float)microtime(true) * 1000.0);
	}

	/**
	 * @param array<string,mixed> $data
	 *
	 * @return array<int,mixed>
	 */
	private function sanitizeElements(array $data): array {
		$elements = [];

		foreach ($data as $element) {
			if (is_array($element)) {
				$element = $this->withStringIds($element);
				// As Excalidraw restores stamps, but always integers; clients read them the same way
				$element['version'] = max($this->safeInteger($element['version'] ?? null) ?? 1, 1);
				$element['versionNonce'] = $this->safeInteger($element['versionNonce'] ?? null) ?? 0;
				$elements[] = $element;
			}
		}

		return $elements;
	}

	/**
	 * Excalidraw's ids are strings; a board written by another tool may number
	 * its elements, and then also the references to them
	 *
	 * @param array<mixed> $element
	 * @return array<mixed>
	 */
	private function withStringIds(array $element): array {
		$string = static fn (mixed $id): mixed => is_int($id) ? (string)$id : $id;
		foreach (['id', 'containerId', 'frameId'] as $key) {
			if (array_key_exists($key, $element)) {
				$element[$key] = $string($element[$key]);
			}
		}
		foreach (['startBinding', 'endBinding'] as $key) {
			if (is_array($element[$key] ?? null) && array_key_exists('elementId', $element[$key])) {
				$element[$key]['elementId'] = $string($element[$key]['elementId']);
			}
		}
		if (is_array($element['boundElements'] ?? null)) {
			foreach ($element['boundElements'] as $index => $bound) {
				if (is_array($bound) && array_key_exists('id', $bound)) {
					$element['boundElements'][$index]['id'] = $string($bound['id']);
				}
			}
		}
		return $element;
	}

	/**
	 * @param array<string,mixed> $files
	 *
	 * @return array<string,mixed>
	 */
	private function sanitizeFiles(array $files): array {
		$sanitized = [];

		foreach ($files as $key => $file) {
			if ($file === null) {
				continue;
			}

			if (is_array($file)) {
				$sanitized[$key] = $file;
			}
		}

		if (!empty($sanitized)) {
			ksort($sanitized);
		}

		return $sanitized;
	}

	/**
	 * @param array<mixed> $items
	 *
	 * @return array<int,mixed>
	 */
	private function sanitizeLibraryItems(array $items): array {
		$sanitized = [];

		foreach ($items as $item) {
			if (!is_array($item) || !isset($item['elements']) || !is_array($item['elements']) || count($item['elements']) === 0) {
				continue;
			}

			unset($item['libraryName'], $item['scope'], $item['filename'], $item['basename']);
			$item['elements'] = array_values($item['elements']);
			$sanitized[] = $item;
		}

		return $sanitized;
	}

	/**
	 * @param array<string,mixed> $appState
	 *
	 * @return array<string,mixed>
	 */
	private function sanitizeAppState(array $appState): array {
		unset($appState['collaborators'], $appState['selectedElementIds']);

		if (!empty($appState)) {
			ksort($appState);
		}

		return $appState;
	}

	/**
	 * The board settings a client may change, with values the editor accepts
	 *
	 * @param array<mixed> $settings
	 * @return array<string,mixed>
	 */
	private function sanitizeSettings(array $settings): array {
		$sanitized = [];
		foreach (self::BOARD_SETTINGS as $key) {
			$value = $settings[$key] ?? null;
			$valid = $key === 'viewBackgroundColor'
				? is_string($value) && strlen($value) <= 100
				: is_int($value) && $value > 0 && $value <= 1000;
			if ($valid) {
				$sanitized[$key] = $value;
			}
		}
		return $sanitized;
	}

	/**
	 * A board references at most one library by {scope, name}; the live items
	 * are resolved on open, so updating the library propagates to every board.
	 *
	 * @param mixed $ref
	 *
	 * @return array{scope: string, name: string}|null
	 */
	private function sanitizeLibraryRef($ref): ?array {
		if (!is_array($ref)) {
			return null;
		}
		$scope = $ref['scope'] ?? null;
		$name = $ref['name'] ?? null;
		if (($scope === WhiteboardFolderService::SCOPE_PERSONAL || $scope === WhiteboardFolderService::SCOPE_ORG)
			&& is_string($name) && WhiteboardFolderService::isValidName($name)) {
			return ['scope' => $scope, 'name' => $name];
		}
		return null;
	}

	/**
	 * @param mixed $value
	 *
	 * @return mixed
	 */
	/**
	 * Excalidraw changes the version and nonce of an element on every edit, so
	 * equal versions mean an unchanged scene, also when a newer client
	 * serializes old elements differently (for example upgraded arrow bindings).
	 *
	 * @param array<string,mixed> $current
	 * @param array<string,mixed> $merged
	 */
	private function hasSameElementVersions(array $current, array $merged): bool {
		$versions = static function (array $data): ?array {
			$list = [];
			foreach ($data['elements'] ?? [] as $element) {
				if (!is_array($element) || !is_int($element['version'] ?? null) || !is_int($element['versionNonce'] ?? null)) {
					return null;
				}
				$list[] = [$element['id'] ?? null, $element['version'], $element['versionNonce']];
			}
			return $list;
		};

		$currentVersions = $versions($current);
		if ($currentVersions === null || $currentVersions !== $versions($merged)) {
			return false;
		}

		unset($current['elements'], $merged['elements']);
		return $current === $merged;
	}

	private function canonicalize($value) {
		if (is_array($value)) {
			if (!$this->isList($value)) {
				ksort($value);
			}

			foreach ($value as $key => $item) {
				$value[$key] = $this->canonicalize($item);
			}
		}

		return $value;
	}

	private function isList(array $array): bool {
		if (function_exists('array_is_list')) {
			return array_is_list($array);
		}

		$expectedKey = 0;
		foreach ($array as $key => $_) {
			if ($key !== $expectedKey) {
				return false;
			}
			$expectedKey++;
		}

		return true;
	}
}
