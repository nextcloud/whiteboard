<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use InvalidArgumentException;
use OCP\Files\IRootFolder;
use OCP\Files\Template\ITemplateManager;
use OCP\IConfig;
use PHPUnit\Framework\Attributes\DataProvider;
use Psr\Log\LoggerInterface;
use Test\TestCase;

class WhiteboardFolderServiceTest extends TestCase {
	private WhiteboardFolderService $service;

	protected function setUp(): void {
		parent::setUp();
		$this->service = new WhiteboardFolderService(
			$this->createMock(ITemplateManager::class),
			$this->createMock(IRootFolder::class),
			$this->createMock(IConfig::class),
			$this->createMock(LoggerInterface::class),
		);
	}

	public function testNormalizeScopeAcceptsKnownScopes(): void {
		$this->assertSame('personal', $this->service->normalizeScope('personal'));
		$this->assertSame('org', $this->service->normalizeScope('org'));
	}

	public function testNormalizeScopeRejectsUnknownScope(): void {
		$this->expectException(InvalidArgumentException::class);
		$this->service->normalizeScope('global');
	}

	public function testNormalizeNameTrimsWhitespace(): void {
		$this->assertSame('My shapes', $this->service->normalizeName('  My shapes  '));
	}

	#[DataProvider('invalidNameProvider')]
	public function testNormalizeNameRejectsInvalidNames(string $name): void {
		$this->expectException(InvalidArgumentException::class);
		$this->service->normalizeName($name);
	}

	public static function invalidNameProvider(): array {
		return [
			'empty' => [''],
			'whitespace only' => ['   '],
			'dot' => ['.'],
			'dot dot' => ['..'],
			'slash' => ['a/b'],
			'backslash' => ['a\\b'],
			'control char' => ["a\x01b"],
			'too long' => [str_repeat('x', 251)],
			'windows reserved' => ['CON'],
			'windows reserved lowercase' => ['nul'],
			'windows reserved with extension' => ['com1.board'],
		];
	}

	public function testIsValidNameMatchesNormalizeName(): void {
		$this->assertTrue(WhiteboardFolderService::isValidName('My shapes'));
		$this->assertTrue(WhiteboardFolderService::isValidName('console'));
		$this->assertFalse(WhiteboardFolderService::isValidName('CON'));
		$this->assertFalse(WhiteboardFolderService::isValidName(''));
		$this->assertFalse(WhiteboardFolderService::isValidName('a/b'));
		$this->assertFalse(WhiteboardFolderService::isValidName(' padded '));
		$this->assertFalse(WhiteboardFolderService::isValidName(str_repeat('x', 251)));
	}
}
