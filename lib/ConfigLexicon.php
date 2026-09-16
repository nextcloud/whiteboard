<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard;

use OCP\Config\Lexicon\Entry;
use OCP\Config\Lexicon\ILexicon;
use OCP\Config\Lexicon\Strictness;
use OCP\Config\ValueType;
use OCP\IAppConfig;

class ConfigLexicon implements ILexicon {
	#[\Override]
	public function getStrictness(): Strictness {
		return Strictness::IGNORE;
	}

	#[\Override]
	public function getAppConfigs(): array {
		return [
			new Entry(
				ConfigKeys::JWT_SECRET_KEY,
				ValueType::STRING,
				defaultRaw: '',
				definition: 'Shared secret used to sign the JWT tokens exchanged with the collaboration server',
				lazy: true,
				flags: IAppConfig::FLAG_SENSITIVE,
			),
			new Entry(
				ConfigKeys::MAX_FILE_SIZE,
				ValueType::INT,
				defaultRaw: 10,
				definition: 'Maximum file size in MB accepted when uploading files to a whiteboard',
				lazy: false,
			),
			new Entry(
				ConfigKeys::COLLAB_BACKEND_URL,
				ValueType::STRING,
				defaultRaw: '',
				definition: 'URL of the whiteboard collaboration server',
				lazy: false,
			),
			new Entry(
				ConfigKeys::DISABLE_EXTERNAL_LIBRARIES,
				ValueType::BOOL,
				defaultRaw: false,
				definition: 'Whether to disable loading external libraries (e.g. mermaid, excalidraw-libraries) from the internet',
				lazy: false,
			),
		];
	}

	#[\Override]
	public function getUserConfigs(): array {
		return [
			new Entry(
				ConfigKeys::USER_RECORDING_AUTO_UPLOAD_ON_DISCONNECT,
				ValueType::BOOL,
				defaultRaw: false,
				definition: 'Whether to automatically upload the recording when a user gets disconnected',
			),
			new Entry(
				ConfigKeys::USER_LEGACY_LIBRARIES_MIGRATED,
				ValueType::BOOL,
				defaultRaw: false,
				definition: 'Whether the legacy Excalidraw libraries of the user have already been migrated',
			),
		];
	}
}
