<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Service\File;

use OCP\Files\File;

interface GetFileService {
	public function getFile(): File;

	public function isFileReadOnly(): bool;
}
