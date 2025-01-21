<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Whiteboard\Controller;

use Exception;
use OCA\Whiteboard\Service\StatsService;
use OCP\AppFramework\ApiController;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;
use OCP\IUserManager;

/**
 * @psalm-suppress UndefinedClass
 * @psalm-suppress UndefinedDocblockClass
 */
final class StatsController extends ApiController {
    public function __construct(
        $appName,
        IRequest $request,
        private StatsService $statsService,
        private IUserManager $userManager,
    ) {
        parent::__construct($appName, $request);
    }

    public function summary(): DataResponse {
        $totalBoards = $this->statsService->getTotalBoards();
        $totalUsers = array_sum($this->userManager->countUsers());

        return new DataResponse([
            'totalActiveUsers' => $this->statsService->getTotalActiveUsers(),
            'totalBoards' => $totalBoards,
            'totalSize' => $this->statsService->getTotalSize(), // @TODO: size in bytes
            'totalElements' => $this->statsService->getTotalElements(),
            'averageBoardsPerUser' => $totalBoards / $totalUsers,
        ]);
    }

    public function getActiveUsersData(): DataResponse {
        // @TODO
        return new DataResponse([
            'data' => $this->statsService->getActiveUsersData(),
        ]);
    }
}
