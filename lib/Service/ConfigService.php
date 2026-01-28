<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use OCP\AppFramework\Services\IAppConfig;
use OCP\IConfig;

final class ConfigService {
	private const USER_AUTO_UPLOAD_ON_DISCONNECT = 'recording_auto_upload_on_disconnect';

	public function __construct(
		private IAppConfig $appConfig,
		private IConfig $config,
	) {
	}

	public function getJwtSecretKey(): string {
		if (!method_exists($this->appConfig, 'getAppValueString')) {
			return $this->appConfig->getAppValue('jwt_secret_key');
		}

		return $this->appConfig->getAppValueString('jwt_secret_key');
	}

	public function getMaxFileSize(): int {
		if (!method_exists($this->appConfig, 'getAppValueInt')) {
			return (int)$this->appConfig->getAppValue('max_file_size', '10');
		}

		return $this->appConfig->getAppValueInt('max_file_size', 10);
	}

	public function setMaxFileSize(int $maxFileSize): void {
		if (!method_exists($this->appConfig, 'setAppValueInt')) {
			$this->appConfig->setAppValue('max_file_size', (string)$maxFileSize);
			return;
		}

		$this->appConfig->setAppValueInt('max_file_size', $maxFileSize);
	}

	public function getCollabBackendUrl(): string {
		if (!method_exists($this->appConfig, 'getAppValueString')) {
			return $this->trimUrl($this->appConfig->getAppValue('collabBackendUrl'));
		}

		return $this->trimUrl($this->appConfig->getAppValueString('collabBackendUrl'));
	}

	public function setCollabBackendUrl(string $collabBackendUrl): void {
		if (!method_exists($this->appConfig, 'setAppValueString')) {
			$this->appConfig->setAppValue('collabBackendUrl', $collabBackendUrl);
			return;
		}

		$this->appConfig->setAppValueString('collabBackendUrl', $collabBackendUrl);
	}

	private function trimUrl(string $url): string {
		return rtrim(trim($url), '/');
	}

	public function getWhiteboardSharedSecret(): string {
		if (!method_exists($this->appConfig, 'getAppValueString')) {
			return $this->appConfig->getAppValue('jwt_secret_key');
		}

		return $this->appConfig->getAppValueString('jwt_secret_key');
	}

	public function setWhiteboardSharedSecret(string $jwtSecretKey): void {
		if (!method_exists($this->appConfig, 'setAppValueString')) {
			$this->appConfig->setAppValue('jwt_secret_key', $jwtSecretKey);
			return;
		}

		$this->appConfig->setAppValueString('jwt_secret_key', $jwtSecretKey);
	}

	public function getDisableExternalLibraries(): bool {
		return $this->appConfig->getAppValueBool('disable_external_libraries');
	}

	public function getUserAutoUploadOnDisconnect(?string $userId): bool {
		if (!$userId) {
			return false;
		}
		return $this->config->getUserValue($userId, 'whiteboard', self::USER_AUTO_UPLOAD_ON_DISCONNECT, 'false') === 'true';
	}

	public function setUserAutoUploadOnDisconnect(string $userId, bool $enabled): void {
		$this->config->setUserValue($userId, 'whiteboard', self::USER_AUTO_UPLOAD_ON_DISCONNECT, $enabled ? 'true' : 'false');
	}
}
