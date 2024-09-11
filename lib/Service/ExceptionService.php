<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use Exception;
use OCA\Whiteboard\Exception\InvalidUserException;
use OCA\Whiteboard\Exception\UnauthorizedException;
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
		return match (true) {
			$e instanceof NotFoundException => Http::STATUS_NOT_FOUND,
			$e instanceof NotPermittedException => Http::STATUS_FORBIDDEN,
			$e instanceof UnauthorizedException => Http::STATUS_UNAUTHORIZED,
			$e instanceof InvalidUserException => Http::STATUS_BAD_REQUEST,
			default => (int)($e->getCode() ?: Http::STATUS_INTERNAL_SERVER_ERROR),
		};
	}

	private function getMessage(Exception $e): string {
		return match (true) {
			$e instanceof NotFoundException => 'File not found',
			$e instanceof NotPermittedException => 'Permission denied',
			$e instanceof UnauthorizedException => 'Unauthorized',
			$e instanceof InvalidUserException => 'Invalid user',
			default => $e->getMessage() ?: 'An error occurred',
		};
	}
}
