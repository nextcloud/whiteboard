<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Controller;

use Exception;
use OCA\Whiteboard\AppInfo\Application;
use OCA\Whiteboard\Service\Authentication\AuthenticateUserServiceFactory;
use OCA\Whiteboard\Service\ConfigService;
use OCA\Whiteboard\Service\File\GetFileServiceFactory;
use OCA\Whiteboard\Service\JWTService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\NotFoundResponse;
use OCP\AppFramework\Http\Response;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\AppFramework\Services\IInitialState;
use OCP\IRequest;
use OCP\Util;
use Psr\Log\LoggerInterface;

/**
 * Serves the standalone editor page used as the library return URL when
 * installing libraries from https://libraries.excalidraw.com. The editor
 * inside the Files app viewer has no URL of its own, so the "Add to your
 * Excalidraw" link would otherwise point at the Files app, which does not
 * handle the addLibrary URL fragment.
 *
 * @psalm-suppress UndefinedClass
 * @psalm-suppress MissingDependency
 */
final class PageController extends Controller {
	public function __construct(
		IRequest $request,
		private IInitialState $initialState,
		private ConfigService $configService,
		private AuthenticateUserServiceFactory $authenticateUserServiceFactory,
		private GetFileServiceFactory $getFileServiceFactory,
		private JWTService $jwtService,
		private LoggerInterface $logger,
	) {
		parent::__construct('whiteboard', $request);
	}

	/**
	 * @NoCSRFRequired
	 * @NoAdminRequired
	 */
	public function standalone(int $fileId): Response {
		try {
			$user = $this->authenticateUserServiceFactory->create(null)->authenticate();
			$fileService = $this->getFileServiceFactory->create($user, $fileId);
			$file = $fileService->getFile();
			$jwt = $this->jwtService->generateJWT($user, $file, $fileService->isFileReadOnly());

			Util::addScript('whiteboard', 'whiteboard-main');
			Util::addStyle('whiteboard', 'whiteboard-main');
			Util::addScript('text', 'text-editor');

			$this->initialState->provideInitialState('file_id', $file->getId());
			$this->initialState->provideInitialState('standalonePage', true);
			$this->initialState->provideInitialState('jwt', $jwt);
			$this->initialState->provideInitialState('collabBackendUrl', $this->configService->getCollabBackendUrl());
			$this->initialState->provideInitialState('maxFileSize', $this->configService->getMaxFileSize());

			return new TemplateResponse(Application::APP_ID, 'directEditing', [], 'base');
		} catch (Exception $e) {
			$this->logger->warning('Could not render standalone whiteboard page', ['exception' => $e]);
			return new NotFoundResponse();
		}
	}
}
