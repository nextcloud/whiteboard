<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */


namespace OCA\Whiteboard\AppInfo;

use OCA\Viewer\Event\LoadViewer;
use OCA\Whiteboard\Listener\AddContentSecurityPolicyListener;
use OCA\Whiteboard\Listener\LoadViewerListener;
use OCA\Whiteboard\Listener\RegisterTemplateCreatorListener;
use OCP\AppFramework\App;
use OCP\Security\CSP\AddContentSecurityPolicyEvent;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;
use OCP\Files\Template\RegisterTemplateCreatorEvent;

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
	}

	public function boot(IBootContext $context): void {

	}
}
