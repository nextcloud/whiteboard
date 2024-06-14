<?php

declare(strict_types=1);
/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
namespace OCA\Whiteboard\Listener;

use OC;
use OCA\Whiteboard\AppInfo\Application;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Files\Template\RegisterTemplateCreatorEvent;
use OCP\Files\Template\TemplateFileCreator;
use OCP\IL10N;

/** @template-implements IEventListener<RegisterTemplateCreatorEvent|Event> */
final class RegisterTemplateCreatorListener implements IEventListener {
	public function __construct(
		private IL10N $l10n
	) {
	}

	public function handle(Event $event): void {
		if (!($event instanceof RegisterTemplateCreatorEvent)) {
			return;
		}

		$event->getTemplateManager()->registerTemplateFileCreator(function () {
			$whiteboard = new TemplateFileCreator(Application::APP_ID, $this->l10n->t('New whiteboard'), '.excalidraw');
			$whiteboard->addMimetype('application/vnd.excalidraw+json');
			$whiteboard->setIconSvgInline(file_get_contents(OC::$SERVERROOT . '/core/img/filetypes/whiteboard.svg'));
			$whiteboard->setActionLabel($this->l10n->t('Create new whiteboard'));
			return $whiteboard;
		});
	}
}
