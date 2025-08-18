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
		if (empty($data)) {
			$data = ['elements' => [], 'scrollToContent' => true];
		}

		$maxRetries = 3;
		$baseDelay = 1000000; // 1 second
		$fileId = $file->getId();

		for ($attempt = 0; $attempt < $maxRetries; $attempt++) {
			try {
				$file->putContent(json_encode($data, JSON_THROW_ON_ERROR));
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

				// Simple exponential backoff
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
}
