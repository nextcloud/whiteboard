<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use OCA\Whiteboard\Exception\TemplatesFolderUnavailableException;
use OCP\AppFramework\Http;
use OCP\Files\NotFoundException;
use Psr\Log\LoggerInterface;
use Test\TestCase;

class ExceptionServiceTest extends TestCase {
	public function testMissingTemplatesFolderIsNotReportedAsAMissingFile(): void {
		$service = new ExceptionService($this->createStub(LoggerInterface::class));

		$this->assertSame(Http::STATUS_FAILED_DEPENDENCY, $service->handleException(new TemplatesFolderUnavailableException('alice'))->getStatus());
		$this->assertSame(Http::STATUS_NOT_FOUND, $service->handleException(new NotFoundException())->getStatus());
	}
}
