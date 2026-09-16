<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\AppInfo;

use OCA\Whiteboard\ConfigLexicon;
use OCP\AppFramework\Bootstrap\IRegistrationContext;
use OCP\Config\Lexicon\ILexicon;

class ApplicationTest extends \Test\TestCase {

	public function testRegistersConfigLexiconWhenSupported(): void {
		$registrationContext = $this->createMock(IRegistrationContext::class);
		$registrationContext->expects(interface_exists(ILexicon::class) ? $this->once() : $this->never())
			->method('registerConfigLexicon')
			->with(ConfigLexicon::class);

		$app = new Application();
		$app->register($registrationContext);
	}
}
