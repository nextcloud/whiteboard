<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Controller;

use OCA\Whiteboard\Service\CanvasTemplateService;
use OCA\Whiteboard\Service\WhiteboardFolderService;
use OCA\Whiteboard\Service\WhiteboardLibraryService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\DataResponse;
use OCP\Files\File;
use OCP\IRequest;
use OCP\IUserSession;
use Psr\Log\LoggerInterface;

/**
 * Metadata for the "New whiteboard" template picker: a map of file id to
 * {kind, scope} so the Files-app enhancement script can group entries by
 * scope and badge them as library or canvas template. Best-effort — every source
 * failure is swallowed so the native picker keeps working.
 *
 * @psalm-suppress UndefinedClass
 * @psalm-suppress MissingDependency
 * @psalm-suppress UnusedClass
 */
final class PickerController extends Controller {
	private const KIND_LIBRARY = 'library';
	private const KIND_CANVAS_TEMPLATE = 'canvas-template';

	/** Pointer boards are tiny; anything bigger is a real canvas template. */
	private const MAX_POINTER_BYTES = 64 * 1024;

	public function __construct(
		IRequest $request,
		private IUserSession $userSession,
		private WhiteboardLibraryService $libraryService,
		private CanvasTemplateService $canvasTemplateService,
		private WhiteboardFolderService $folders,
		private LoggerInterface $logger,
	) {
		parent::__construct('whiteboard', $request);
	}

	#[NoAdminRequired]
	public function index(): DataResponse {
		$entries = [];

		try {
			foreach ($this->libraryService->getOrgLibraryPointerFiles() as $file) {
				$entries[(string)$file->getId()] = ['kind' => self::KIND_LIBRARY, 'scope' => WhiteboardFolderService::SCOPE_ORG];
			}
		} catch (\Throwable $e) {
			$this->logger->warning('Failed to list organization library pointers for picker', ['app' => 'whiteboard', 'exception' => $e]);
		}

		try {
			foreach ($this->canvasTemplateService->getOrgCanvasTemplateFiles() as $file) {
				$entries[(string)$file->getId()] = ['kind' => self::KIND_CANVAS_TEMPLATE, 'scope' => WhiteboardFolderService::SCOPE_ORG];
			}
		} catch (\Throwable $e) {
			$this->logger->warning('Failed to list organization canvas templates for picker', ['app' => 'whiteboard', 'exception' => $e]);
		}

		try {
			$uid = $this->userSession->getUser()?->getUID();
			if ($uid !== null && $uid !== '') {
				foreach ($this->folders->getUserTemplateFolder($uid)->getDirectoryListing() as $node) {
					if (!$node instanceof File || !str_ends_with(strtolower($node->getName()), '.whiteboard')) {
						continue;
					}
					$entries[(string)$node->getId()] = [
						'kind' => $this->isLibraryPointer($node) ? self::KIND_LIBRARY : self::KIND_CANVAS_TEMPLATE,
						'scope' => WhiteboardFolderService::SCOPE_PERSONAL,
					];
				}
			}
		} catch (\Throwable $e) {
			$this->logger->warning('Failed to list personal templates for picker', ['app' => 'whiteboard', 'exception' => $e]);
		}

		return new DataResponse(['entries' => $entries]);
	}

	private function isLibraryPointer(File $file): bool {
		if ($file->getSize() > self::MAX_POINTER_BYTES) {
			return false;
		}
		try {
			$content = json_decode($file->getContent(), true, 16);
		} catch (\Throwable) {
			return false;
		}
		return is_array($content) && isset($content['libraryRef']);
	}
}
