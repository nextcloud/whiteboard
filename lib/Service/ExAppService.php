<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use OCA\AppAPI\Service\ExAppService as AppAPIService;
use OCA\Whiteboard\Consts\ExAppConsts;
use OCP\App\IAppManager;
use OCP\AppFramework\Services\IInitialState;
use Psr\Container\ContainerInterface;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * @psalm-suppress UndefinedClass
 * @psalm-suppress MissingDependency
 */
final class ExAppService {
	private ?AppAPIService $appAPIService = null;

	public function __construct(
		private IAppManager        $appManager,
		private ContainerInterface $container,
		private IInitialState      $initialState,
		private LoggerInterface    $logger,
	) {
		$this->initAppAPIService();
	}

	private function initAppAPIService(): void {
		$isAppAPIEnabled = $this->isAppAPIEnabled();

		if (class_exists(AppAPIService::class) && $isAppAPIEnabled) {
			try {
				$this->appAPIService = $this->container->get(AppAPIService::class);
			} catch (Throwable $e) {
				$this->logger->error('exApp', [$e->getMessage()]);
			}
		}
	}

	private function isAppAPIEnabled(): bool {
		return $this->appManager->isEnabledForUser(ExAppConsts::APP_API_ID);
	}

	public function isExAppEnabled(string $appId): bool {
		if ($this->appAPIService === null) {
			return false;
		}

		return $this->appAPIService->getExApp($appId)?->getEnabled() === 1;
	}

	public function isWhiteboardWebsocketEnabled(): bool {
		return $this->isExAppEnabled(ExAppConsts::WHITEBOARD_EX_APP_ID);
	}

	public function initFrontendState(): void {
		$this->initialState->provideInitialState(
			ExAppConsts::WHITEBOARD_EX_APP_ENABLED_KEY,
			$this->isWhiteboardWebsocketEnabled()
		);
	}
}
