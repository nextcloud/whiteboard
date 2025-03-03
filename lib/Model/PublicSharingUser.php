<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Model;

final class PublicSharingUser implements User {
	public function __construct(
		private string $publicSharingToken,
	) {
	}

	#[\Override]
	public function getUID(): string {
		return $this->generateRandomUID();
	}

	#[\Override]
	public function getDisplayName(): string {
		return $this->generateRandomDisplayName();
	}

	public function getPublicSharingToken(): string {
		return $this->publicSharingToken;
	}

	private function generateRandomUID(): string {
		return 'shared_' . $this->publicSharingToken . '_' . bin2hex(random_bytes(8));
	}

	private function generateRandomDisplayName(): string {
		$adjectives = ['Anonymous', 'Mysterious', 'Incognito', 'Unknown', 'Unnamed'];
		$nouns = ['User', 'Visitor', 'Guest', 'Collaborator', 'Participant'];

		$adjective = $adjectives[array_rand($adjectives)];
		$noun = $nouns[array_rand($nouns)];

		return $adjective . ' ' . $noun;
	}
}
