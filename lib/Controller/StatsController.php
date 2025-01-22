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
            'totalSize' => $this->statsService->getTotalSize(), // @TODO: convert size in bytes to human readable format
            'totalElements' => $this->statsService->getTotalElements(),
            'averageBoardsPerUser' => $totalBoards / $totalUsers,
        ]);
    }

    public function getActiveUsersCount(): DataResponse {
        $timeFrames = $this->request->getParam('time_frames', []);
        return new DataResponse([
            'data' => $this->statsService->getHighActiveUsersByTimeFrames($timeFrames),
        ]);
    }

    public function getStoredBoardsCount(): DataResponse {
        $timeFrames = $this->request->getParam('time_frames', []);
        return new DataResponse([
            'data' => $this->statsService->getStoredBoardsByTimeFrames($timeFrames),
        ]);
    }

    public function getUsersStoredBoards(): DataResponse {
        $filter = $this->request->getParam('filter', []);
        $orderBy = $this->request->getParam('orderBy', 'boards');
        $offset = $this->request->getParam('offset', 0);
        $limit = $this->request->getParam('limit', 10);

        return new DataResponse([
            'data' => $this->statsService->getUsersStoredBoards($filter, $orderBy, $offset, $limit),
        ]);
    }

    public function getBoardsInfo(): DataResponse {
        $filter = $this->request->getParam('filter', []);
        $orderBy = $this->request->getParam('orderBy', 'boards');
        $offset = $this->request->getParam('offset', 0);
        $limit = $this->request->getParam('limit', 10);

        return new DataResponse([
            'data' => $this->statsService->getBoardsInfo($filter, $orderBy, $offset, $limit),
        ]);
    }
}
