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
use OCP\IDBConnection;
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
		private IAppManager $appManager,
		private ContainerInterface $container,
		private IInitialState $initialState,
		private LoggerInterface $logger,
		private IDBConnection $dbConnection,
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

	/**
	 * Get the ExApp secret for the whiteboard ExApp
	 * This secret is used for JWT authentication between Nextcloud and the ExApp
	 */
	public function getWhiteboardExAppSecret(): ?string {
		if ($this->appAPIService === null) {
			return null;
		}

		try {
			$exApp = $this->appAPIService->getExApp(ExAppConsts::WHITEBOARD_EX_APP_ID);
			if ($exApp === null) {
				$this->logger->debug('ExApp not found', ['appId' => ExAppConsts::WHITEBOARD_EX_APP_ID]);
				return null;
			}

			// Try to get the secret using the getSecret method
			try {
				if (method_exists($exApp, 'getSecret')) {
					$secret = $exApp->getSecret();
					if ($secret !== null && $secret !== '') {
						$this->logger->debug('ExApp secret retrieved successfully via getSecret method');
						return $secret;
					}
				}
			} catch (Throwable $e) {
				$this->logger->warning('Failed to get secret via getSecret method', [
					'error' => $e->getMessage()
				]);
			}

			$this->logger->info('ExApp secret not accessible via getSecret method, trying database fallback', [
				'appId' => ExAppConsts::WHITEBOARD_EX_APP_ID
			]);

			// Fallback: try to get secret directly from database
			return $this->getExAppSecretFromDatabase(ExAppConsts::WHITEBOARD_EX_APP_ID);
		} catch (Throwable $e) {
			$this->logger->error('Failed to retrieve ExApp secret', [
				'appId' => ExAppConsts::WHITEBOARD_EX_APP_ID,
				'error' => $e->getMessage()
			]);

			// Final fallback: try database access
			return $this->getExAppSecretFromDatabase(ExAppConsts::WHITEBOARD_EX_APP_ID);
		}
	}

	/**
	 * Fallback method to get ExApp secret directly from database
	 */
	private function getExAppSecretFromDatabase(string $appId): ?string {
		try {
			$this->logger->debug('Attempting to retrieve ExApp secret from database', ['appId' => $appId]);

			$qb = $this->dbConnection->getQueryBuilder();
			$qb->select('secret')
				->from('ex_apps')
				->where($qb->expr()->eq('appid', $qb->createNamedParameter($appId)));

			$result = $qb->executeQuery();
			$row = $result->fetch();
			$result->closeCursor();

			if ($row && isset($row['secret']) && $row['secret'] !== '') {
				$this->logger->debug('ExApp secret retrieved successfully from database');
				return $row['secret'];
			}

			$this->logger->warning('ExApp secret not found in database or is empty', ['appId' => $appId]);
			return null;
		} catch (Throwable $e) {
			$this->logger->error('Failed to retrieve ExApp secret from database', [
				'appId' => $appId,
				'error' => $e->getMessage()
			]);
			return null;
		}
	}
}
