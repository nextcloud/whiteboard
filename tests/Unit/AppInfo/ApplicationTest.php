<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */


namespace OCA\Whiteboard\AppInfo;

use OCA\Whiteboard\Template\GlobalLibraryTemplateProvider;
use OCP\AppFramework\Bootstrap\IRegistrationContext;

class ApplicationTest extends \Test\TestCase {

	public function testApp(): void {
		$registrationContext = $this->createMock(IRegistrationContext::class);
		$registrationContext->expects($this->once())
			->method('registerTemplateProvider')
			->with(GlobalLibraryTemplateProvider::class);

		$app = new Application();
		$app->register($registrationContext);
		self::assertTrue(true);
	}
}
