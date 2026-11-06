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

final class WhiteboardContentService {
	private const CREATOR_PROOF_DOMAIN = 'whiteboard.creator.v1';
	private const CREATOR_PROOF_PREFIX = 'v1:';

	private string $creatorSecret;

	public function __construct(
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
		if (!is_array($board)) {
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
	 * they are; files are added under new ids only. Each changed element and
	 * file gets the revision `$rev`.
	 *
	 * @param array<string,mixed> $stored decoded board
	 * @param array<mixed> $elements
	 * @param array<mixed> $files
	 * @return array{board: array<string,mixed>, elements: list<string>, files: list<string>}
	 */
	public function merge(array $stored, array $elements, array $files, User $actor, int $fileId, int $rev): array {
		$board = $this->normalizeStoredData($stored);
		$byId = $this->indexElementsById($board['elements']);
		$actorInfo = $this->buildActorInfo($actor, $this->getCurrentTimeInMilliseconds());
		$changedElements = [];
		$appended = [];

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
				$appended[] = $elementId;
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

		if ($changedElements === [] && $changedFiles === []) {
			return ['board' => $stored, 'elements' => [], 'files' => []];
		}

		$order = array_merge(array_keys($this->indexElementsById($board['elements'])), $appended);
		$board['elements'] = $this->orderElements(array_map(static fn (string $id) => $byId[$id], $order));
		ksort($board['files']);
		$board['revisions'] = $this->getRevisions($stored);
		foreach (array_keys($changedElements) as $id) {
			$board['revisions']['elements'][$id] = $rev;
		}
		foreach (array_keys($changedFiles) as $id) {
			$board['revisions']['files'][$id] = $rev;
		}

		return ['board' => $board, 'elements' => array_map('strval', array_keys($changedElements)), 'files' => array_keys($changedFiles)];
	}

	/**
	 * A whole board that replaces the stored one (a restored version), with
	 * every element and file at revision `$rev`. The board keeps its library.
	 *
	 * @param array<string,mixed> $stored decoded board, empty when unreadable
	 * @param array<string,mixed> $replacement
	 * @return array<string,mixed>
	 */
	public function replace(array $stored, array $replacement, int $rev): array {
		$board = $this->normalizeStoredData($this->unwrapData($replacement));
		$current = $this->normalizeStoredData($stored);
		foreach (['libraryRef', 'libraryItems'] as $key) {
			unset($board[$key]);
			if (array_key_exists($key, $current)) {
				$board[$key] = $current[$key];
			}
		}
		$board['elements'] = $this->orderElements($board['elements']);
		$board['revisions'] = [
			'elements' => array_fill_keys(array_map('strval', array_keys($this->indexElementsById($board['elements']))), $rev),
			'files' => array_fill_keys(array_map('strval', array_keys($board['files'])), $rev),
		];
		return $board;
	}

	/**
	 * The elements and files changed after revision `$since`
	 *
	 * @param array<string,mixed> $board decoded board
	 * @return array{elements: list<array<string,mixed>>, files: array<string,mixed>}
	 */
	public function changesSince(array $board, int $since): array {
		$revisions = $this->getRevisions($board);
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
		return ['elements' => $elements, 'files' => $files];
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
		return max([0, ...array_values($revisions['elements']), ...array_values($revisions['files'])]);
	}

	/**
	 * @param array<string,mixed> $board
	 * @return array{elements: array<string,int>, files: array<string,int>}
	 */
	private function getRevisions(array $board): array {
		$revisions = ['elements' => [], 'files' => []];
		foreach (['elements', 'files'] as $kind) {
			foreach (is_array($board['revisions'][$kind] ?? null) ? $board['revisions'][$kind] : [] as $id => $rev) {
				if (is_int($rev)) {
					$revisions[$kind][(string)$id] = $rev;
				}
			}
		}
		return $revisions;
	}

	/**
	 * Excalidraw's order: higher version, then lower nonce
	 *
	 * @param array<string,mixed> $incoming
	 * @param array<string,mixed> $stored
	 */
	private function wins(array $incoming, array $stored): bool {
		$version = is_int($incoming['version'] ?? null) ? $incoming['version'] : 0;
		$storedVersion = is_int($stored['version'] ?? null) ? $stored['version'] : 0;
		if ($version !== $storedVersion) {
			return $version > $storedVersion;
		}
		$nonce = is_int($incoming['versionNonce'] ?? null) ? $incoming['versionNonce'] : 0;
		$storedNonce = is_int($stored['versionNonce'] ?? null) ? $stored['versionNonce'] : 0;
		return $nonce < $storedNonce;
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
				$elements[] = $element;
			}
		}

		return $elements;
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
}
