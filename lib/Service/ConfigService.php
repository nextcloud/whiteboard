<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use OCP\AppFramework\Services\IAppConfig;

final class ConfigService {
	public function __construct(
		private IAppConfig $appConfig,
	) {
	}

	public function getJwtSecretKey(): string {
		return $this->appConfig->getAppValueString('jwt_secret_key');
	}

	public function getCollabBackendUrl(): string {
		return $this->appConfig->getAppValueString('collabBackendUrl');
	}

	public function setCollabBackendUrl(string $collabBackendUrl): void {
		$this->appConfig->setAppValueString('collabBackendUrl', $collabBackendUrl);
	}

	public function getWhiteboardSharedSecret(): string {
		return $this->appConfig->getAppValueString('jwt_secret_key');
	}

	public function setWhiteboardSharedSecret(string $jwtSecretKey): void {
		$this->appConfig->setAppValueString('jwt_secret_key', $jwtSecretKey);
	}
}
