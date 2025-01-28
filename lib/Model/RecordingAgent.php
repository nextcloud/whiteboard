<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Model;

final class RecordingAgent implements User {
	public function __construct(
		private string $fileId,
		private string $userId,
		private string $sharedToken,
	) {
	}

	public function getUID(): string {
		return 'recording_agent_' . $this->fileId . '_' . $this->userId;
	}

	public function getDisplayName(): string {
		return 'Recording Agent ' . $this->fileId . ' for ' . $this->userId;
	}

	public function getFileId(): string {
		return $this->fileId;
	}

	public function getSharedToken(): string {
		return $this->sharedToken;
	}

	public function getNCUserId(): string {
		return $this->userId;
	}
}
