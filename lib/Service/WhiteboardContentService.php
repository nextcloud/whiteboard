<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use JsonException;
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
	public function updateContent(File $file, array $data): void {
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

		$merged = $this->mergeData($current, $incoming);

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

		if (array_key_exists('appState', $incoming) && is_array($incoming['appState'])) {
			$normalized['appState'] = $this->sanitizeAppState($incoming['appState']);
		}

		if (array_key_exists('scrollToContent', $incoming)) {
			$normalized['scrollToContent'] = (bool)$incoming['scrollToContent'];
		}

		return $normalized;
	}

	/**
	 * @param array<string,mixed> $payload
	 */
	private function isEffectivelyEmptyPayload(array $payload): bool {
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
			if (!in_array($key, ['elements', 'files', 'appState', 'scrollToContent'], true)) {
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

		if (array_key_exists('appState', $stored) && is_array($stored['appState'])) {
			$normalized['appState'] = $this->sanitizeAppState($stored['appState']);
		} elseif (array_key_exists('appState', $stored) && $stored['appState'] === null) {
			unset($normalized['appState']);
		}

		if (array_key_exists('scrollToContent', $stored)) {
			$normalized['scrollToContent'] = (bool)$stored['scrollToContent'];
		}

		return $normalized;
	}

	/**
	 * @param array<string,mixed> $current
	 * @param array<string,mixed> $incoming
	 *
	 * @return array<string,mixed>
	 */
	private function mergeData(array $current, array $incoming): array {
		$merged = $current;

		if (array_key_exists('elements', $incoming)) {
			$merged['elements'] = $incoming['elements'];
		}

		if (array_key_exists('files', $incoming)) {
			$merged['files'] = $incoming['files'];
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

		return $merged;
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
		unset($appState['collaborators'], $appState['selectedElementIds']);

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
