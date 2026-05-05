<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\DirectEditing;

use OCP\DirectEditing\ACreateEmpty;
use OCP\IL10N;

class WhiteboardCreator extends ACreateEmpty {

	public const CREATOR_ID = 'whiteboard';

	public function __construct(
		private IL10N $l10n,
	) {
	}

	#[\Override]
	public function getId(): string {
		return self::CREATOR_ID;
	}

	#[\Override]
	public function getName(): string {
		return $this->l10n->t('whiteboard');
	}

	#[\Override]
	public function getExtension(): string {
		return 'whiteboard';
	}

	#[\Override]
	public function getMimetype(): string {
		return 'application/vnd.excalidraw+json';
	}
}
