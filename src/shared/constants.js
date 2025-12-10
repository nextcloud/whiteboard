/*
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const SOCKET_MSG = {
	READ_ONLY: 'read-only',
	INIT_ROOM: 'init-room',
	IMAGE_DATA: 'image-data',
	ROOM_USER_CHANGE: 'room-user-change',
	ROOM_NOT_FOUND: 'room-not-found',
	CLIENT_BROADCAST: 'client-boardcast',
	IMAGE_REMOVE: 'image-remove',
	ERROR: 'error',

	VOTING_START: 'voting-start',
	VOTING_VOTE: 'voting-vote',
	VOTING_END: 'voting-end',
	VOTINGS_INIT: 'votings-init',
	VOTING_STARTED: 'voting-started',
	VOTING_VOTED: 'voting-voted',
	VOTING_ENDED: 'voting-ended',
}
