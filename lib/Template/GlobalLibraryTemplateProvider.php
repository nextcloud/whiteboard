<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Template;

use Exception;
use OCA\Whiteboard\Service\WhiteboardLibraryService;
use OCP\Files\File;
use OCP\Files\NotFoundException;
use OCP\Files\Template\ICustomTemplateProvider;
use OCP\Files\Template\Template;
use Psr\Log\LoggerInterface;

/**
 * @psalm-suppress UndefinedClass
 */
final class GlobalLibraryTemplateProvider implements ICustomTemplateProvider {
	private const WHITEBOARD_MIMETYPE = 'application/vnd.excalidraw+json';

	/**
	 * @psalm-suppress PossiblyUnusedMethod
	 */
	public function __construct(
		private WhiteboardLibraryService $libraryService,
		private LoggerInterface $logger,
	) {
	}

	/**
	 * @return Template[]
	 */
	#[\Override]
	public function getCustomTemplates(string $mimetype): array {
		if ($mimetype !== self::WHITEBOARD_MIMETYPE) {
			return [];
		}

		try {
			return array_map(
				static fn (File $file): Template => new Template(self::class, substr($file->getName(), 0, -strlen('.excalidrawlib')), $file),
				array_values($this->libraryService->getGlobalTemplateFiles())
			);
		} catch (Exception $e) {
			$this->logger->warning('Failed to list organization whiteboard library templates', [
				'exception' => $e,
			]);
			return [];
		}
	}

	/**
	 * @throws NotFoundException
	 */
	#[\Override]
	public function getCustomTemplate(string $template): File {
		try {
			return $this->libraryService->getGlobalTemplateFile($template);
		} catch (NotFoundException $e) {
			throw $e;
		} catch (Exception $e) {
			$this->logger->warning('Failed to load organization whiteboard library template', [
				'template' => $template,
				'exception' => $e,
			]);
			throw new NotFoundException('Organization library template not found');
		}
	}
}
