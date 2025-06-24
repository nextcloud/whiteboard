<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */


namespace OCA\Whiteboard\AppInfo;

use OCA\AppAPI\Middleware\AppAPIAuthMiddleware;
use OCA\Files_Sharing\Event\BeforeTemplateRenderedEvent;
use OCA\Viewer\Event\LoadViewer;
use OCA\Whiteboard\Listener\AddContentSecurityPolicyListener;
use OCA\Whiteboard\Listener\BeforeTemplateRenderedListener;
use OCA\Whiteboard\Listener\LoadViewerListener;
use OCA\Whiteboard\Listener\RegisterTemplateCreatorListener;
use OCA\Whiteboard\Service\ConfigService;
use OCA\Whiteboard\Service\ExAppService;
use OCA\Whiteboard\Settings\SetupCheck;
use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;
use OCP\Files\Template\ITemplateManager;
use OCP\Files\Template\RegisterTemplateCreatorEvent;
use OCP\IL10N;
use OCP\IURLGenerator;
use OCP\Security\CSP\AddContentSecurityPolicyEvent;
use OCP\Util;
use Psr\Container\ContainerExceptionInterface;
use Psr\Container\NotFoundExceptionInterface;
use Psr\Log\LoggerInterface;

/**
 * @psalm-suppress UndefinedClass
 * @psalm-suppress InvalidArgument
 */
class Application extends App implements IBootstrap {
	public const APP_ID = 'whiteboard';

	public function __construct(array $params = []) {
		parent::__construct(self::APP_ID, $params);
	}

	#[\Override]
	public function register(IRegistrationContext $context): void {
		include_once __DIR__ . '/../../vendor/autoload.php';

		$context->registerEventListener(AddContentSecurityPolicyEvent::class, AddContentSecurityPolicyListener::class);
		$context->registerEventListener(LoadViewer::class, LoadViewerListener::class);
		$context->registerEventListener(RegisterTemplateCreatorEvent::class, RegisterTemplateCreatorListener::class);
		$context->registerEventListener(BeforeTemplateRenderedEvent::class, BeforeTemplateRenderedListener::class);
		$context->registerSetupCheck(SetupCheck::class);

		if (class_exists(AppAPIAuthMiddleware::class) && $this->getExAppService()->isWhiteboardWebsocketEnabled()) {
			$context->registerMiddleware(AppAPIAuthMiddleware::class);
		}

		// Auto-configure collaboration URL and JWT secret if ExApp is detected
		$this->configureExAppCollaboration();
	}

	#[\Override]
	public function boot(IBootContext $context): void {
		[$major] = Util::getVersion();
		if ($major < 30) {
			$context->injectFn(function (ITemplateManager $templateManager, IL10N $l10n) {
				$templateManager->registerTemplateFileCreator(function () use ($l10n) {
					return RegisterTemplateCreatorListener::getTemplateFileCreator($l10n);
				});
			});
		}
	}

	/**
	 * Automatically configure collaboration URL and JWT secret when ExApp is detected
	 */
	private function configureExAppCollaboration(): void {
		try {
			$container = $this->getContainer();
			$exAppService = $container->get(ExAppService::class);
			$configService = $container->get(ConfigService::class);
			$urlGenerator = $container->get(IURLGenerator::class);

			if ($exAppService->isWhiteboardWebsocketEnabled()) {
				// Generate the ExApp collaboration URL
				$baseUrl = $urlGenerator->getAbsoluteURL('');
				$exAppUrl = rtrim($baseUrl, '/') . '/exapps/nextcloud_whiteboard';

				// Check current URL configuration
				$currentUrl = $configService->getCollabBackendUrl();

				// Force update to ExApp URL when ExApp is detected (for dynamic configuration)
				if ($currentUrl !== $exAppUrl) {
					$configService->setCollabBackendUrl($exAppUrl);
				}

				// Configure JWT secret synchronization with ExApp
				$this->configureExAppJwtSecret($exAppService, $configService);
			}
		} catch (\Exception) {
			// Silently fail - this is auto-configuration, shouldn't break app registration
		}
	}

	/**
	 * Configure JWT secret synchronization between Nextcloud and ExApp
	 */
	private function configureExAppJwtSecret(ExAppService $exAppService, ConfigService $configService): void {
		try {
			$logger = $this->getContainer()->get(LoggerInterface::class);
			$logger->debug('Starting JWT secret synchronization for ExApp');

			// Get the ExApp secret from app_api
			$exAppSecret = $exAppService->getWhiteboardExAppSecret();

			if ($exAppSecret !== null && $exAppSecret !== '') {
				$logger->debug('ExApp secret retrieved successfully');

				// Get current JWT secret from whiteboard config
				$currentJwtSecret = $configService->getJwtSecretKey();

				// Update JWT secret if it's different from ExApp secret
				if ($currentJwtSecret !== $exAppSecret) {
					$logger->info('Updating whiteboard JWT secret to match ExApp secret');
					$configService->setWhiteboardSharedSecret($exAppSecret);
				} else {
					$logger->debug('JWT secret already matches ExApp secret, no update needed');
				}
			} else {
				$logger->warning('ExApp secret is null or empty, cannot synchronize JWT secret');
			}
		} catch (\Exception $e) {
			// Log the error but don't break app registration
			try {
				$logger = $this->getContainer()->get(LoggerInterface::class);
				$logger->error('Failed to configure ExApp JWT secret', ['error' => $e->getMessage()]);
			} catch (\Exception) {
				// Silently fail if we can't even get the logger
			}
		}
	}

	/**
	 * @throws ContainerExceptionInterface
	 * @throws NotFoundExceptionInterface
	 */
	private function getExAppService(): ExAppService {
		return $this->getContainer()->get(ExAppService::class);
	}
}
