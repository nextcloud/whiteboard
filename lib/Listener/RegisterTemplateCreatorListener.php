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
		private IL10N $l10n,
	) {
	}

	#[\Override]
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
		$whiteboard->addMimetype('application/octet-stream');

		// Always use the custom SVG icon for consistency
		$iconContent = file_get_contents(__DIR__ . '/../../img/app-filetype.svg');
		if ($iconContent !== false) {
			// For NC 29+, use the native method
			if (method_exists($whiteboard, 'setIconSvgInline')) {
				$whiteboard->setIconSvgInline($iconContent);
			} else {
				// For NC 28, use custom CSS to display the SVG
				$whiteboard->setIconClass('whiteboard-template-icon');
				
				// Register custom CSS to display the SVG
				\OCP\Util::addStyle('whiteboard', 'template-icon');
			}
		} else {
			// Fallback to generic template icon
			$whiteboard->setIconClass('icon-template-add');
		}

		$whiteboard->setActionLabel($l10n->t('Create new whiteboard'));
		return $whiteboard;
	}
}
