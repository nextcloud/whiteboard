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
	private const CREATOR_PROOF_PREFIX = 'v1:';

	private string $creatorSecret;

	public function __construct(
		private LoggerInterface $logger,
		ConfigService $configService,
	) {
		$this->creatorSecret = $configService->getJwtSecretKey();
	}

	/**
	 * @throws NotPermittedException
	 * @throws GenericFileException
	 * @throws LockedException
	 * @throws JsonException
	 */
	public function getContent(File $file): array {
		$fileContent = $file->getContent();
		if ($fileContent === '') {
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
			$current = $this->getEmptyState();
		}

		$actorInfo = $this->buildActorInfo($actor, $this->getCurrentTimeInMilliseconds());
		$merged = $this->mergeData($current, $incoming, $actorInfo, $fileId);

		$canonicalCurrent = $this->canonicalize($current);
		$canonicalMerged = $this->canonicalize($merged);

		if ($canonicalCurrent === $canonicalMerged) {
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
	 *
	 * @throws JsonException
	 */
	private function normalizeStoredData(array $stored): array {
		$stored = $this->unwrapData($stored);

		if (empty($stored)) {
			return $this->getEmptyState();
		}

		$normalized = $this->getEmptyState();

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
		} elseif (array_key_exists('appState', $stored) && $stored['appState'] === null) {
			unset($normalized['appState']);
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

	/**
	 * @param mixed $value
	 *
	 * @return mixed
	 */
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
