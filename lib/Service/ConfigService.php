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
	private const ALLOWED_COLLAB_CSP_SCHEMES = ['http', 'https', 'ws', 'wss'];

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

	/**
	 * @return list<string>
	 */
	public function getCollabBackendCspConnectDomains(): array {
		$url = $this->getCollabBackendUrl();
		if ($url === '') {
			return [];
		}

		$parts = parse_url($url);
		if ($parts === false || !isset($parts['scheme'], $parts['host'])) {
			return [];
		}

		$scheme = strtolower($parts['scheme']);
		if (!in_array($scheme, self::ALLOWED_COLLAB_CSP_SCHEMES, true)) {
			return [];
		}

		$host = strtolower($parts['host']);
		if (!$this->isValidCspHost($host)) {
			return [];
		}

		$port = isset($parts['port']) ? ':' . $parts['port'] : '';
		$origin = $scheme . '://' . $host . $port;

		$domains = [$origin];
		if ($scheme === 'http') {
			$domains[] = 'ws://' . $host . $port;
		} elseif ($scheme === 'https') {
			$domains[] = 'wss://' . $host . $port;
		} elseif ($scheme === 'ws') {
			$domains[] = 'http://' . $host . $port;
		} elseif ($scheme === 'wss') {
			$domains[] = 'https://' . $host . $port;
		}

		return array_values(array_unique($domains));
	}

	private function isValidCspHost(string $host): bool {
		if ($host === '' || strlen($host) > 255) {
			return false;
		}

		if (str_starts_with($host, '[') || str_ends_with($host, ']')) {
			if (!str_starts_with($host, '[') || !str_ends_with($host, ']')) {
				return false;
			}

			return filter_var(substr($host, 1, -1), FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) !== false;
		}

		if (filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false) {
			return true;
		}

		return preg_match('/^[a-z0-9._-]+$/', $host) === 1
			&& !str_contains($host, '..');
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
