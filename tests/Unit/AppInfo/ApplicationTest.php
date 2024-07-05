<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */


namespace OCA\Whiteboard\AppInfo;

class ApplicationTest extends \Test\TestCase {

	public function testApp(): void {
		$registrationContext = $this->createMock(\OCP\AppFramework\Bootstrap\IRegistrationContext::class);
		$app = new Application();
		$app->register($registrationContext);
		self::assertTrue(true);
	}
}
