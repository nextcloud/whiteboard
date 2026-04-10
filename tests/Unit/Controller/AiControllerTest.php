<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Controller;

use OCA\Whiteboard\Service\AiTagService;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;
use PHPUnit\Framework\MockObject\MockObject;
use Test\TestCase;

class AiControllerTest extends TestCase {
	private AiController $controller;
	/** @var AiTagService&MockObject */
	private AiTagService $aiTagService;

	protected function setUp(): void {
		parent::setUp();
		$this->aiTagService = $this->createMock(AiTagService::class);
		$this->controller = new AiController(
			'whiteboard',
			$this->createMock(IRequest::class),
			$this->aiTagService,
		);
	}

	public function testTagFileReturnsEmptyDataResponse(): void {
		$this->aiTagService->expects($this->once())
			->method('tagFileAsAiGenerated')
			->with(1488);

		$response = $this->controller->tagFile(1488);

		$this->assertInstanceOf(DataResponse::class, $response);
		$this->assertSame([], $response->getData());
	}

	public function testTagFilePassesCorrectFileId(): void {
		$this->aiTagService->expects($this->once())
			->method('tagFileAsAiGenerated')
			->with(99999);

		$this->controller->tagFile(99999);
	}
}
