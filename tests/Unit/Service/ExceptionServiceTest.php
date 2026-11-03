<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use Exception;
use JsonException;
use OCA\Whiteboard\Exception\TemplatesFolderUnavailableException;
use OCA\Whiteboard\Exception\UnauthorizedException;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;
use PHPUnit\Framework\Attributes\DataProvider;
use Psr\Log\LoggerInterface;
use Psr\Log\LogLevel;
use Test\TestCase;

final class ExceptionServiceTest extends TestCase {
	public static function exceptionProvider(): array {
		return [
			'missing file' => [new NotFoundException('File not found'), 404, LogLevel::DEBUG],
			'no permission' => [new NotPermittedException('No read permission'), 403, LogLevel::DEBUG],
			'unauthorized' => [new UnauthorizedException('Unauthorized'), 401, LogLevel::DEBUG],
			'templates folder unavailable' => [new TemplatesFolderUnavailableException('alice'), 424, LogLevel::ERROR],
			'server error' => [new Exception('Database is gone'), 500, LogLevel::ERROR],
			'malformed board' => [new JsonException('Syntax error', JSON_ERROR_SYNTAX), JSON_ERROR_SYNTAX, LogLevel::ERROR],
		];
	}

	#[DataProvider('exceptionProvider')]
	public function testLogsOnlyServerErrorsAsErrors(Exception $exception, int $status, string $level): void {
		$logger = $this->createMock(LoggerInterface::class);
		$logger->expects($this->once())
			->method('log')
			->with($level, 'Exception handled: ' . get_class($exception));

		$response = (new ExceptionService($logger))->handleException($exception);

		$this->assertSame($status, $response->getStatus());
	}
}
