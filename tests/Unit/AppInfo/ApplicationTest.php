<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\AppInfo;

use OC\Files\Filesystem;
use OC\Files\Mount\MountPoint;
use OC\Files\Storage\Temporary;
use OC\Files\Storage\Wrapper\Wrapper;
use OCA\Whiteboard\ConfigLexicon;
use OCA\Whiteboard\Storage\BoardWriteGuard;
use OCP\AppFramework\Bootstrap\IBootContext;
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

	public function testBootGuardsSavesAgainstWritesOfOthers(): void {
		Filesystem::getLoader()->removeStorageWrapper('whiteboard');
		(new Application())->boot($this->createStub(IBootContext::class));
		\OC_Hook::emit('OC_Filesystem', 'preSetup', ['user' => 'alice']);

		$storage = (new MountPoint(new Temporary([]), '/alice/files', null, Filesystem::getLoader()))->getStorage();
		$wrappers = [];
		while ($storage instanceof Wrapper) {
			$wrappers[] = $storage::class;
			$storage = $storage->getWrapperStorage();
		}
		$this->assertContains(BoardWriteGuard::class, $wrappers);
	}

	#[\Override]
	protected function tearDown(): void {
		// As the test bootstrap leaves it
		\OC_Hook::clear('OC_Filesystem');
		Filesystem::getLoader()->removeStorageWrapper('whiteboard');
		parent::tearDown();
	}
}
