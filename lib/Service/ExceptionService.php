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
use Psr\Log\LoggerInterface;

/**
 * @psalm-suppress UndefinedClass
 */
final class ExceptionService {
	public function __construct(
		private LoggerInterface $logger,
	) {
	}

	public function handleException(Exception $e): DataResponse {
		$statusCode = $this->getStatusCode($e);
		$message = $this->getMessage($e);

		// Log the exception with context for debugging
		$this->logger->error('Exception handled: ' . get_class($e), [
			'message' => $e->getMessage(),
			'code' => $e->getCode(),
			'file' => $e->getFile(),
			'line' => $e->getLine(),
			'status_code' => $statusCode,
			'user_message' => $message,
			'trace' => $this->getTraceAsString($e),
		]);

		return new DataResponse(['message' => $message], $statusCode);
	}

	private function getStatusCode(Exception $e): int {
		$statusCode = match (true) {
			$e instanceof NotFoundException => Http::STATUS_NOT_FOUND,
			$e instanceof NotPermittedException => Http::STATUS_FORBIDDEN,
			$e instanceof UnauthorizedException => Http::STATUS_UNAUTHORIZED,
			$e instanceof InvalidUserException => Http::STATUS_BAD_REQUEST,
			default => (int)($e->getCode() ?: Http::STATUS_INTERNAL_SERVER_ERROR),
		};

		$this->logger->warning('Determined status code for exception', [
			'exception_type' => get_class($e),
			'status_code' => $statusCode,
		]);

		return $statusCode;
	}

	private function getMessage(Exception $e): string {
		$message = match (true) {
			$e instanceof NotFoundException => 'File not found',
			$e instanceof NotPermittedException => 'Permission denied',
			$e instanceof UnauthorizedException => 'Unauthorized',
			$e instanceof InvalidUserException => 'Invalid user',
			default => $e->getMessage() ?: 'An error occurred',
		};

		$this->logger->warning('Generated user-facing message', [
			'exception_type' => get_class($e),
			'original_message' => $e->getMessage(),
			'user_message' => $message,
		]);

		return $message;
	}

	private function getTraceAsString(Exception $e): string {
		$traceLines = explode("\n", $e->getTraceAsString());
		$limitedTrace = array_slice($traceLines, 0, 10);
		
		if (count($traceLines) > 10) {
			$limitedTrace[] = '... ' . (count($traceLines) - 10) . ' more lines truncated';
		}
		
		return implode("\n", $limitedTrace);
	}
}
