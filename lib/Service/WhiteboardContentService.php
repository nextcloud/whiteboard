<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use InvalidArgumentException;
use JsonException;
use OCA\Whiteboard\Exception\WhiteboardConflictException;
use OCP\AppFramework\Http;
use OCP\Files\File;
use OCP\Files\GenericFileException;
use OCP\Files\NotPermittedException;
use OCP\Lock\LockedException;
use Psr\Log\LoggerInterface;

final class WhiteboardContentService {
	public function __construct(
		private LoggerInterface $logger,
	) {
	}

	/**
	 * @return array<string,mixed>
	 *
	 * @throws NotPermittedException
	 * @throws GenericFileException
	 * @throws LockedException
	 * @throws JsonException
	 */
	public function getContent(File $file): array {
		$fileContent = $file->getContent();
		if ($fileContent === '') {
			return $this->getEmptyDocument();
		}

		$decoded = json_decode($fileContent, true, 512, JSON_THROW_ON_ERROR);
		if (!is_array($decoded)) {
			return $this->getEmptyDocument();
		}

		return $this->normalizeStoredDocument($decoded);
	}

	/**
	 * @return array<string,mixed>
	 *
	 * @throws NotPermittedException
	 * @throws GenericFileException
	 * @throws LockedException
	 * @throws JsonException
	 * @throws WhiteboardConflictException
	 */
	public function updateContent(File $file, array $data, string $updatedBy): array {
		$fileId = $file->getId();
		$hadPersistedMeta = false;

		try {
			$fileContent = $file->getContent();
			if ($fileContent === '') {
				$currentDocument = $this->getEmptyDocument();
			} else {
				$decoded = json_decode($fileContent, true, 512, JSON_THROW_ON_ERROR);
				if (!is_array($decoded)) {
					$currentDocument = $this->getEmptyDocument();
				} else {
					$unwrapped = $this->unwrapData($decoded);
					$hadPersistedMeta = array_key_exists('meta', $unwrapped) && is_array($unwrapped['meta']);
					$currentDocument = $this->normalizeStoredDocument($decoded);
				}
			}
		} catch (JsonException $e) {
			$this->logger->warning('Existing whiteboard content is invalid JSON, resetting to defaults', [
				'app' => 'whiteboard',
				'fileId' => $fileId,
				'error' => $e->getMessage(),
			]);
			$currentDocument = $this->getEmptyDocument();
		}

		$incoming = $this->normalizeIncomingPayload($data);
		$currentSnapshot = $this->canonicalize($this->extractSnapshot($currentDocument));
		$incomingSnapshot = $this->canonicalize($this->extractSnapshot($incoming['document']));

		if ($currentSnapshot === $incomingSnapshot) {
			if (!$hadPersistedMeta && $incoming['baseRev'] === $currentDocument['meta']['persistedRev']) {
				$updatedDocument = $incoming['document'];
				$updatedDocument['meta'] = [
					'persistedRev' => 1,
					'updatedAt' => $this->currentTimeMs(),
					'updatedBy' => $updatedBy,
				];

				$this->writeDocument($file, $updatedDocument);

				return $updatedDocument['meta'];
			}

			$this->logger->debug('Skipping whiteboard save because payload matches stored content', [
				'app' => 'whiteboard',
				'fileId' => $fileId,
				'persistedRev' => $currentDocument['meta']['persistedRev'],
			]);
			return $currentDocument['meta'];
		}

		$currentRev = $currentDocument['meta']['persistedRev'];
		if ($incoming['baseRev'] !== $currentRev) {
			throw new WhiteboardConflictException($currentDocument);
		}

		$updatedDocument = $incoming['document'];
		$updatedDocument['meta'] = [
			'persistedRev' => $currentRev + 1,
			'updatedAt' => $this->currentTimeMs(),
			'updatedBy' => $updatedBy,
		];

		$this->writeDocument($file, $updatedDocument);

		return $updatedDocument['meta'];
	}

	/**
	 * @return array<string,mixed>
	 */
	private function getEmptyDocument(): array {
		return [
			'meta' => [
				'persistedRev' => 0,
				'updatedAt' => null,
				'updatedBy' => null,
			],
			'elements' => [],
			'files' => [],
			'appState' => [],
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
	 * @param array<string,mixed> $payload
	 *
	 * @return array{baseRev:int,document:array<string,mixed>}
	 */
	private function normalizeIncomingPayload(array $payload): array {
		$payload = $this->unwrapData($payload);
		$baseRev = $this->parseBaseRev($payload);

		return [
			'baseRev' => $baseRev,
			'document' => $this->normalizeSnapshot($payload, true),
		];
	}

	/**
	 * @param array<string,mixed> $stored
	 *
	 * @return array<string,mixed>
	 */
	private function normalizeStoredDocument(array $stored): array {
		$stored = $this->unwrapData($stored);

		if (empty($stored)) {
			return $this->getEmptyDocument();
		}

		$document = $this->normalizeSnapshot($stored, false);
		$document['meta'] = $this->normalizeMeta($stored['meta'] ?? null);

		return [
			'meta' => $document['meta'],
			'elements' => $document['elements'],
			'files' => $document['files'],
			'appState' => $document['appState'],
			'scrollToContent' => $document['scrollToContent'],
		];
	}

	/**
	 * @param array<string,mixed> $payload
	 *
	 * @return array<string,mixed>
	 */
	private function normalizeSnapshot(array $payload, bool $requireElements): array {
		if ($requireElements && (!array_key_exists('elements', $payload) || !is_array($payload['elements']))) {
			throw new InvalidArgumentException('Invalid whiteboard payload: elements must be an array', Http::STATUS_BAD_REQUEST);
		}

		if (array_key_exists('files', $payload) && !is_array($payload['files'])) {
			throw new InvalidArgumentException('Invalid whiteboard payload: files must be an object', Http::STATUS_BAD_REQUEST);
		}

		if (array_key_exists('appState', $payload) && !is_array($payload['appState'])) {
			throw new InvalidArgumentException('Invalid whiteboard payload: appState must be an object', Http::STATUS_BAD_REQUEST);
		}

		return [
			'elements' => (array_key_exists('elements', $payload) && is_array($payload['elements']))
				? $this->sanitizeElements($payload['elements'])
				: [],
			'files' => (array_key_exists('files', $payload) && is_array($payload['files']))
				? $this->sanitizeFiles($payload['files'])
				: [],
			'appState' => (array_key_exists('appState', $payload) && is_array($payload['appState']))
				? $this->sanitizeAppState($payload['appState'])
				: [],
			'scrollToContent' => $this->resolveScrollToContent($payload),
		];
	}

	/**
	 * @param mixed $value
	 *
	 * @return array<string,mixed>
	 */
	private function normalizeMeta($value): array {
		if (!is_array($value)) {
			return $this->getEmptyDocument()['meta'];
		}

		return [
			'persistedRev' => (is_int($value['persistedRev'] ?? null) && $value['persistedRev'] >= 0)
				? $value['persistedRev']
				: 0,
			'updatedAt' => (is_int($value['updatedAt'] ?? null) || is_float($value['updatedAt'] ?? null))
				? (int)$value['updatedAt']
				: null,
			'updatedBy' => is_string($value['updatedBy'] ?? null)
				? $value['updatedBy']
				: null,
		];
	}

	/**
	 * @param array<string,mixed> $payload
	 */
	private function parseBaseRev(array $payload): int {
		if (!array_key_exists('baseRev', $payload) || !is_int($payload['baseRev']) || $payload['baseRev'] < 0) {
			throw new InvalidArgumentException('Invalid whiteboard payload: baseRev must be a non-negative integer', Http::STATUS_BAD_REQUEST);
		}

		return $payload['baseRev'];
	}

	/**
	 * @param array<string,mixed> $payload
	 */
	private function resolveScrollToContent(array $payload): bool {
		if (array_key_exists('scrollToContent', $payload)) {
			return (bool)$payload['scrollToContent'];
		}

		if (array_key_exists('appState', $payload) && is_array($payload['appState']) && array_key_exists('scrollToContent', $payload['appState'])) {
			return (bool)$payload['appState']['scrollToContent'];
		}

		return true;
	}

	/**
	 * @param array<string,mixed> $document
	 *
	 * @return array<string,mixed>
	 */
	private function extractSnapshot(array $document): array {
		return [
			'elements' => $document['elements'],
			'files' => $document['files'],
			'appState' => $document['appState'],
			'scrollToContent' => $document['scrollToContent'],
		];
	}

	/**
	 * @param array<string,mixed> $document
	 *
	 * @throws JsonException
	 * @throws LockedException
	 * @throws GenericFileException
	 * @throws NotPermittedException
	 */
	private function writeDocument(File $file, array $document): void {
		$fileId = $file->getId();

		try {
			$encodedPayload = json_encode($this->canonicalize($document), JSON_THROW_ON_ERROR);
		} catch (JsonException $e) {
			$this->logger->error('Failed to encode whiteboard content before saving', [
				'app' => 'whiteboard',
				'fileId' => $fileId,
				'error' => $e->getMessage(),
			]);
			throw $e;
		}

		$maxRetries = 3;
		$baseDelay = 1000000;

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
	 * @param array<string,mixed> $appState
	 *
	 * @return array<string,mixed>
	 */
	private function sanitizeAppState(array $appState): array {
		unset($appState['collaborators'], $appState['selectedElementIds'], $appState['scrollToContent']);

		if (!empty($appState)) {
			ksort($appState);
		}

		return $appState;
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

	private function currentTimeMs(): int {
		return (int)round(microtime(true) * 1000);
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
