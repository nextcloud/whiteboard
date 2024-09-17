<?php

declare(strict_types=1);
/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
namespace OCA\Whiteboard\Listener;

use OCA\Whiteboard\AppInfo\Application;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Files\Template\RegisterTemplateCreatorEvent;
use OCP\Files\Template\TemplateFileCreator;
use OCP\IL10N;

/** @template-implements IEventListener<RegisterTemplateCreatorEvent|Event> */
/**
 * @psalm-suppress UndefinedClass
 * @psalm-suppress MissingTemplateParam
 */
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
			return self::getTemplateFileCreator($this->l10n);
		});
	}

	public static function getTemplateFileCreator(IL10N $l10n): TemplateFileCreator {
		$whiteboard = new TemplateFileCreator(Application::APP_ID, $l10n->t('New whiteboard'), '.whiteboard');
		$whiteboard->addMimetype('application/vnd.excalidraw+json');
		$whiteboard->setIconSvgInline(file_get_contents(__DIR__ . '/../../img/app-filetype.svg'));
		$whiteboard->setActionLabel($l10n->t('Create new whiteboard'));
		return $whiteboard;
	}
}
