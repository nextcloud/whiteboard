<?php

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Settings;

use OCP\IL10N;
use OCP\IURLGenerator;
use OCP\Settings\IIconSection;

class Section implements IIconSection {
	public function __construct(
		private IURLGenerator $url,
		private IL10N $l10n,
	) {
	}

	#[\Override]
	public function getID() {
		return 'whiteboard';
	}

	#[\Override]
	public function getName() {
		return $this->l10n->t('Whiteboard');
	}

	#[\Override]
	public function getPriority() {
		return 75;
	}

	#[\Override]
	public function getIcon() {
		return $this->url->imagePath('whiteboard', 'app-dark.svg');
	}
}
