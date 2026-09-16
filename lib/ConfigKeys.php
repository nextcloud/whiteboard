<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard;

final class ConfigKeys {
	public const JWT_SECRET_KEY = 'jwt_secret_key';
	public const MAX_FILE_SIZE = 'max_file_size';
	public const COLLAB_BACKEND_URL = 'collabBackendUrl';
	public const DISABLE_EXTERNAL_LIBRARIES = 'disable_external_libraries';

	public const USER_RECORDING_AUTO_UPLOAD_ON_DISCONNECT = 'recording_auto_upload_on_disconnect';
	public const USER_LEGACY_LIBRARIES_MIGRATED = 'legacy_libraries_migrated';
}
