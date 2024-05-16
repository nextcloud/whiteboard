<?php

declare(strict_types=1);

namespace OCA\Whiteboard\Listener;

use OCA\Whiteboard\AppInfo\Application;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Files\Template\RegisterTemplateCreatorEvent;
use OCP\Files\Template\TemplateFileCreator;
use OCP\IL10N;
use OCP\Preview\IMimeIconProvider;

/** @template-implements IEventListener<RegisterTemplateCreatorEvent|Event> */
final class RegisterTemplateCreatorListener implements IEventListener {
	public function __construct(
		private readonly IL10N             $l10n,
		private readonly IMimeIconProvider $mimeIconProvider
	) {
	}

	public function handle(Event $event): void {
		if (!($event instanceof RegisterTemplateCreatorEvent)) {
			return;
		}

		$event->getTemplateManager()->registerTemplateFileCreator(function () {
			$whiteboard = new TemplateFileCreator(Application::APP_ID, $this->l10n->t('New whiteboard'), '.excalidraw');
			$whiteboard->addMimetype('application/vnd.excalidraw+json');
			$whiteboard->setIconSvgInline(file_get_contents($this->mimeIconProvider->getMimeIconUrl('whiteboard')));
			$whiteboard->setActionLabel($this->l10n->t('Create new whiteboard'));
			return $whiteboard;
		});
	}
}
