<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Settings;

use OCA\Whiteboard\Service\ConfigService;
use OCP\AppFramework\Services\IAppConfig;
use OCP\IConfig;
use OCP\IL10N;
use OCP\SetupCheck\SetupResult;
use Test\TestCase;

class SetupCheckTest extends TestCase {
	public function testMissingServerOnlyMeansNoLiveCollaboration(): void {
		$result = $this->setupCheck('', '')->run();

		$this->assertSame(SetupResult::INFO, $result->getSeverity());
		$this->assertStringContainsString('Boards are saved to Nextcloud', $result->getDescription());
		$this->assertStringNotContainsString('to save boards', $result->getDescription());
	}

	public function testMissingSecretStopsLiveCollaborationButNotSaving(): void {
		$result = $this->setupCheck('https://whiteboard.example.com', '')->run();

		$this->assertSame(SetupResult::ERROR, $result->getSeverity());
		$this->assertStringContainsString('real-time collaboration', $result->getDescription());
		$this->assertStringNotContainsString('to save boards', $result->getDescription());
	}

	public function testConfiguredServerPasses(): void {
		$result = $this->setupCheck('https://whiteboard.example.com', 'secret')->run();

		$this->assertSame(SetupResult::SUCCESS, $result->getSeverity());
	}

	private function setupCheck(string $url, string $secret): SetupCheck {
		$appConfig = $this->createStub(IAppConfig::class);
		$appConfig->method('getAppValueString')->willReturnMap([
			['collabBackendUrl', '', false, $url],
			['jwt_secret_key', '', false, $secret],
		]);
		$l10n = $this->createStub(IL10N::class);
		$l10n->method('t')->willReturnArgument(0);

		return new SetupCheck(new ConfigService($appConfig, $this->createStub(IConfig::class)), $l10n);
	}
}
