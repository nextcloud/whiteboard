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
		if (!method_exists($this->appConfig, 'getAppValueString')) {
			return $this->appConfig->getAppValue('jwt_secret_key');
		}

		return $this->appConfig->getAppValueString('jwt_secret_key');
	}

	public function getMaxFileSize(): int {
		return $this->appConfig->getAppValueInt('max_file_size', 10);
	}

	public function setMaxFileSize(int $maxFileSize): void {
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

	public function getInternalCollabBackendUrl(bool $fallback = true): string {
		if (!method_exists($this->appConfig, 'getAppValueString')) {
			$internalUrl = $this->appConfig->getAppValue('collabBackendUrlInternal');
		}

		$internalUrl = $this->appConfig->getAppValueString('collabBackendUrlInternal');

		if ($internalUrl !== '' || !$fallback) {
			return $this->trimUrl($internalUrl);
		}

		return $this->getCollabBackendUrl();
	}

	private function trimUrl(string $url): string {
		return rtrim(trim($url), '/');
	}

	public function setInternalCollabBackendUrl(string $collabBackendUrl): void {
		if (!method_exists($this->appConfig, 'setAppValueString')) {
			$this->appConfig->setAppValue('collabBackendUrlInternal', $collabBackendUrl);
			return;
		}

		$this->appConfig->setAppValueString('collabBackendUrlInternal', $collabBackendUrl);
	}

	public function getSkipTlsVerify(): bool {
		return $this->appConfig->getAppValueBool('skip_tls_verify', false);
	}

	public function setSkipTlsVerify(bool $skip): void {
		$this->appConfig->setAppValueBool('skip_tls_verify', $skip);
	}

	public function getWhiteboardSharedSecret(): string {
		return $this->appConfig->getAppValueString('jwt_secret_key');
	}

	public function setWhiteboardSharedSecret(string $jwtSecretKey): void {
		if (!method_exists($this->appConfig, 'setAppValueString')) {
			$this->appConfig->setAppValue('jwt_secret_key', $jwtSecretKey);
			return;
		}

		$this->appConfig->setAppValueString('jwt_secret_key', $jwtSecretKey);
	}
}
