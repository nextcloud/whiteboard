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

	// Sent from client to server to start a new voting
	VOTING_START: 'voting-start',
	// Sent from client to server to vote on a voting
	VOTING_VOTE: 'voting-vote',
	// Sent from client to server to end a voting
	VOTING_END: 'voting-end',
	// Sent from server to clients once a voting has been started
	VOTING_STARTED: 'voting-started',
	// Sent from server to clients once a vote has been made
	VOTING_VOTED: 'voting-voted',
	// Sent from server to clients once a voting has been ended
	VOTING_ENDED: 'voting-ended',
}
