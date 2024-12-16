<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */


namespace OCA\Whiteboard\AppInfo;

use OCA\Files_Sharing\Event\BeforeTemplateRenderedEvent;
use OCA\Viewer\Event\LoadViewer;
use OCA\Whiteboard\Listener\AddContentSecurityPolicyListener;
use OCA\Whiteboard\Listener\BeforeTemplateRenderedListener;
use OCA\Whiteboard\Listener\LoadViewerListener;
use OCA\Whiteboard\Listener\RegisterTemplateCreatorListener;
use OCA\Whiteboard\Settings\SetupCheck;
use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;
use OCP\Files\Template\ITemplateManager;
use OCP\Files\Template\RegisterTemplateCreatorEvent;
use OCP\IL10N;
use OCP\Security\CSP\AddContentSecurityPolicyEvent;
use OCP\Util;

/**
 * @psalm-suppress UndefinedClass
 * @psalm-suppress InvalidArgument
 */
class Application extends App implements IBootstrap {
	public const APP_ID = 'whiteboard';

	public function __construct(array $params = []) {
		parent::__construct(self::APP_ID, $params);
	}

	public function register(IRegistrationContext $context): void {
		include_once __DIR__ . '/../../vendor/autoload.php';

		$context->registerEventListener(AddContentSecurityPolicyEvent::class, AddContentSecurityPolicyListener::class);
		$context->registerEventListener(LoadViewer::class, LoadViewerListener::class);
		$context->registerEventListener(RegisterTemplateCreatorEvent::class, RegisterTemplateCreatorListener::class);
		$context->registerEventListener(BeforeTemplateRenderedEvent::class, BeforeTemplateRenderedListener::class);
		$context->registerSetupCheck(SetupCheck::class);
	}

	public function boot(IBootContext $context): void {
		[$major] = Util::getVersion();
		if ($major < 30) {
			$context->injectFn(function (ITemplateManager $templateManager, IL10N $l10n) use ($major) {
				$templateManager->registerTemplateFileCreator(function () use ($l10n) {
					return RegisterTemplateCreatorListener::getTemplateFileCreator($l10n);
				});
			});
		}
	}
}
