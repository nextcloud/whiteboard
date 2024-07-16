<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use Exception;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\DataResponse;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;

/**
 * @psalm-suppress UndefinedClass
 */
final class ExceptionService {
	public function handleException(Exception $e): DataResponse {
		$statusCode = $this->getStatusCode($e);
		$message = $this->getMessage($e);

		return new DataResponse(['message' => $message], $statusCode);
	}

	private function getStatusCode(Exception $e): int {
		if ($e instanceof NotFoundException) {
			return Http::STATUS_NOT_FOUND;
		}
		if ($e instanceof NotPermittedException) {
			return Http::STATUS_FORBIDDEN;
		}

		return (int)($e->getCode() ?: Http::STATUS_INTERNAL_SERVER_ERROR);
	}

	private function getMessage(Exception $e): string {
		if ($e instanceof NotFoundException) {
			return 'File not found';
		}
		if ($e instanceof NotPermittedException) {
			return 'Permission denied';
		}
		return $e->getMessage() ?: 'An error occurred';
	}
}
