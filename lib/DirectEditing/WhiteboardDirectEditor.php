<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\DirectEditing;

use OCA\Whiteboard\AppInfo\Application;
use OCA\Whiteboard\Exception\UnauthorizedException;
use OCA\Whiteboard\Service\Authentication\AuthenticateUserServiceFactory;
use OCA\Whiteboard\Service\ConfigService;
use OCA\Whiteboard\Service\JWTService;
use OCP\AppFramework\Http\NotFoundResponse;
use OCP\AppFramework\Http\Response;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\AppFramework\Services\IInitialState;
use OCP\DirectEditing\IEditor;
use OCP\DirectEditing\IToken;
use OCP\Files\InvalidPathException;
use OCP\Files\NotFoundException;
use OCP\IL10N;
use OCP\Util;

class WhiteboardDirectEditor implements IEditor {

	/** @psalm-suppress PossiblyUnusedMethod */
	public function __construct(
		private IL10N $l10n,
		private IInitialState $initialState,
		private ConfigService $configService,
		private JWTService $jwtService,
		private AuthenticateUserServiceFactory $authenticateUserServiceFactory,
	) {
	}

	#[\Override]
	public function getId(): string {
		return Application::APP_ID;
	}

	#[\Override]
	public function getName(): string {
		return $this->l10n->t('Whiteboard');
	}

	#[\Override]
	public function getMimetypes(): array {
		return [
			'application/vnd.excalidraw+json',
		];
	}

	#[\Override]
	public function getMimetypesOptional(): array {
		return [];
	}

	#[\Override]
	public function getCreators(): array {
		return [
			new WhiteboardCreator($this->l10n),
		];
	}

	#[\Override]
	public function isSecure(): bool {
		return false;
	}

	#[\Override]
	public function open(IToken $token): Response {
		$token->useTokenScope();

		try {
			$file = $token->getFile();

			Util::addScript('whiteboard', 'whiteboard-main');
			Util::addStyle('whiteboard', 'whiteboard-main');

			$user = $this->authenticateUserServiceFactory->create(null)->authenticate();
			$jwt = $this->jwtService->generateJWT($user, $file, false);

			$this->initialState->provideInitialState('file_id', $file->getId());
			$this->initialState->provideInitialState('directEditing', true);
			$this->initialState->provideInitialState('jwt', $jwt);
			$this->initialState->provideInitialState('collabBackendUrl', $this->configService->getCollabBackendUrl());

			return new TemplateResponse(Application::APP_ID, 'directEditing', [], 'base');
		} catch (InvalidPathException|NotFoundException|UnauthorizedException) {
			return new NotFoundResponse();
		}
	}
}
