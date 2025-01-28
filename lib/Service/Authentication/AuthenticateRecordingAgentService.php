<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service\Authentication;

use OCA\Whiteboard\Exception\UnauthorizedException;
use OCA\Whiteboard\Model\RecordingAgent;
use OCA\Whiteboard\Model\User;
use OCA\Whiteboard\Service\ConfigService;

final class AuthenticateRecordingAgentService implements AuthenticateUserService {
	public function __construct(
		private ConfigService $configService,
		private string $fileId,
		private string $userId,
		private string $sharedToken,
	) {
	}

	public function authenticate(): User {
		if (!$this->verifySharedToken()) {
			throw new UnauthorizedException('Invalid recording agent token');
		}

		return new RecordingAgent($this->fileId, $this->userId, $this->sharedToken);
	}

	private function verifySharedToken(): bool {
		[$roomId, $timestamp, $signature] = explode(':', $this->sharedToken);

		if ($roomId !== $this->fileId) {
			return false;
		}

		$sharedSecret = $this->configService->getWhiteboardSharedSecret();
		$payload = "$roomId:$timestamp";
		$expectedSignature = hash_hmac('sha256', $payload, $sharedSecret);

		return hash_equals($expectedSignature, $signature);
	}
}
