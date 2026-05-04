<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Template;

use Exception;
use OCA\Whiteboard\Service\CanvasTemplateService;
use OCA\Whiteboard\Service\WhiteboardLibraryService;
use OCP\Files\File;
use OCP\Files\NotFoundException;
use OCP\Files\Template\ICustomTemplateProvider;
use OCP\Files\Template\Template;
use Psr\Log\LoggerInterface;

/**
 * Surfaces organization entries in the "New whiteboard" picker:
 *
 * - Libraries: pointer board files holding a libraryRef; creating from one
 *   makes a board that resolves the library's live items on open.
 * - Canvas templates: full board files whose content Nextcloud copies verbatim.
 *
 * @psalm-suppress UndefinedClass
 */
final class GlobalTemplateProvider implements ICustomTemplateProvider {
	private const WHITEBOARD_MIMETYPE = 'application/vnd.excalidraw+json';
	private const LIBRARY_ID_PREFIX = 'whiteboard-org-library:';
	private const CANVAS_TEMPLATE_ID_PREFIX = 'whiteboard-org-canvas-template:';

	/**
	 * @psalm-suppress PossiblyUnusedMethod
	 */
	public function __construct(
		private WhiteboardLibraryService $libraryService,
		private CanvasTemplateService $canvasTemplateService,
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
			$libraries = array_map(
				fn (File $file): Template => new Template(
					self::class,
					self::LIBRARY_ID_PREFIX . $this->libraryService->libraryNameFromPointer($file->getName()),
					$file
				),
				$this->libraryService->getOrgLibraryPointerFiles()
			);
			$templates = array_map(
				fn (File $file): Template => new Template(
					self::class,
					self::CANVAS_TEMPLATE_ID_PREFIX . $this->canvasTemplateService->canvasTemplateNameFromFile($file->getName()),
					$file
				),
				$this->canvasTemplateService->getOrgCanvasTemplateFiles()
			);
			return array_merge($templates, $libraries);
		} catch (Exception $e) {
			$this->logger->warning('Failed to list organization whiteboard canvas templates', ['exception' => $e]);
			return [];
		}
	}

	/**
	 * @throws NotFoundException
	 */
	#[\Override]
	public function getCustomTemplate(string $template): File {
		if (str_starts_with($template, self::CANVAS_TEMPLATE_ID_PREFIX)) {
			$name = substr($template, strlen(self::CANVAS_TEMPLATE_ID_PREFIX));
			foreach ($this->canvasTemplateService->getOrgCanvasTemplateFiles() as $file) {
				if ($this->canvasTemplateService->canvasTemplateNameFromFile($file->getName()) === $name) {
					return $file;
				}
			}
			throw new NotFoundException('Organization canvas template not found');
		}

		$name = str_starts_with($template, self::LIBRARY_ID_PREFIX)
			? substr($template, strlen(self::LIBRARY_ID_PREFIX))
			: $template;

		foreach ($this->libraryService->getOrgLibraryPointerFiles() as $file) {
			if ($this->libraryService->libraryNameFromPointer($file->getName()) === $name) {
				return $file;
			}
		}

		throw new NotFoundException('Organization library not found');
	}
}
