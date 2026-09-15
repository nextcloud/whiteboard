<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service;

use OCA\Whiteboard\ConfigLexicon;
use OCP\AppFramework\Services\IAppConfig;
use OCP\IConfig;

final class ConfigService {
	private const ALLOWED_COLLAB_CSP_SCHEMES = ['http', 'https', 'ws', 'wss'];

	public function __construct(
		private IAppConfig $appConfig,
		private IConfig $config,
	) {
	}

	public function getJwtSecretKey(): string {
		if (!method_exists($this->appConfig, 'getAppValueString')) {
			return $this->appConfig->getAppValue(ConfigLexicon::JWT_SECRET_KEY);
		}

		return $this->appConfig->getAppValueString(ConfigLexicon::JWT_SECRET_KEY);
	}

	public function getMaxFileSize(): int {
		if (!method_exists($this->appConfig, 'getAppValueInt')) {
			return (int)$this->appConfig->getAppValue(ConfigLexicon::MAX_FILE_SIZE, '10');
		}

		return $this->appConfig->getAppValueInt(ConfigLexicon::MAX_FILE_SIZE, 10);
	}

	public function setMaxFileSize(int $maxFileSize): void {
		if (!method_exists($this->appConfig, 'setAppValueInt')) {
			$this->appConfig->setAppValue(ConfigLexicon::MAX_FILE_SIZE, (string)$maxFileSize);
			return;
		}

		$this->appConfig->setAppValueInt(ConfigLexicon::MAX_FILE_SIZE, $maxFileSize);
	}

	public function getCollabBackendUrl(): string {
		if (!method_exists($this->appConfig, 'getAppValueString')) {
			return $this->trimUrl($this->appConfig->getAppValue(ConfigLexicon::COLLAB_BACKEND_URL));
		}

		return $this->trimUrl($this->appConfig->getAppValueString(ConfigLexicon::COLLAB_BACKEND_URL));
	}

	public function setCollabBackendUrl(string $collabBackendUrl): void {
		if (!method_exists($this->appConfig, 'setAppValueString')) {
			$this->appConfig->setAppValue(ConfigLexicon::COLLAB_BACKEND_URL, $collabBackendUrl);
			return;
		}

		$this->appConfig->setAppValueString(ConfigLexicon::COLLAB_BACKEND_URL, $collabBackendUrl);
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
			return $this->appConfig->getAppValue(ConfigLexicon::JWT_SECRET_KEY);
		}

		return $this->appConfig->getAppValueString(ConfigLexicon::JWT_SECRET_KEY);
	}

	public function setWhiteboardSharedSecret(string $jwtSecretKey): void {
		if (!method_exists($this->appConfig, 'setAppValueString')) {
			$this->appConfig->setAppValue(ConfigLexicon::JWT_SECRET_KEY, $jwtSecretKey);
			return;
		}

		$this->appConfig->setAppValueString(ConfigLexicon::JWT_SECRET_KEY, $jwtSecretKey);
	}

	public function getDisableExternalLibraries(): bool {
		return $this->appConfig->getAppValueBool(ConfigLexicon::DISABLE_EXTERNAL_LIBRARIES);
	}

	public function getUserAutoUploadOnDisconnect(?string $userId): bool {
		if (!$userId) {
			return false;
		}
		return $this->config->getUserValue($userId, 'whiteboard', ConfigLexicon::USER_RECORDING_AUTO_UPLOAD_ON_DISCONNECT, 'false') === 'true';
	}

	public function setUserAutoUploadOnDisconnect(string $userId, bool $enabled): void {
		$this->config->setUserValue($userId, 'whiteboard', ConfigLexicon::USER_RECORDING_AUTO_UPLOAD_ON_DISCONNECT, $enabled ? 'true' : 'false');
	}
}
