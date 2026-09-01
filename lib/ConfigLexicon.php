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
	public const JWT_SECRET_KEY = 'jwt_secret_key';
	public const MAX_FILE_SIZE = 'max_file_size';
	public const COLLAB_BACKEND_URL = 'collabBackendUrl';
	public const DISABLE_EXTERNAL_LIBRARIES = 'disable_external_libraries';

	public const USER_RECORDING_AUTO_UPLOAD_ON_DISCONNECT = 'recording_auto_upload_on_disconnect';
	public const USER_LEGACY_LIBRARIES_MIGRATED = 'legacy_libraries_migrated';

	#[\Override]
	public function getStrictness(): Strictness {
		return Strictness::IGNORE;
	}

	#[\Override]
	public function getAppConfigs(): array {
		return [
			new Entry(
				self::JWT_SECRET_KEY,
				ValueType::STRING,
				defaultRaw: '',
				definition: 'Shared secret used to sign the JWT tokens exchanged with the collaboration server',
				lazy: true,
				flags: IAppConfig::FLAG_SENSITIVE,
			),
			new Entry(
				self::MAX_FILE_SIZE,
				ValueType::INT,
				defaultRaw: 10,
				definition: 'Maximum file size in MB accepted when uploading files to a whiteboard',
				lazy: false,
			),
			new Entry(
				self::COLLAB_BACKEND_URL,
				ValueType::STRING,
				defaultRaw: '',
				definition: 'URL of the whiteboard collaboration server',
				lazy: false,
			),
			new Entry(
				self::DISABLE_EXTERNAL_LIBRARIES,
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
				self::USER_RECORDING_AUTO_UPLOAD_ON_DISCONNECT,
				ValueType::BOOL,
				defaultRaw: false,
				definition: 'Whether to automatically upload the recording when a user gets disconnected',
			),
			new Entry(
				self::USER_LEGACY_LIBRARIES_MIGRATED,
				ValueType::BOOL,
				defaultRaw: false,
				definition: 'Whether the legacy Excalidraw libraries of the user have already been migrated',
			),
		];
	}
}
