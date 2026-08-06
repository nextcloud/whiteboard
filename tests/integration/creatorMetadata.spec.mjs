/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest'
import ViewportService from '../../websocket_server/Services/ViewportService.js'
import CreatorMetadataUtility from '../../websocket_server/Utilities/CreatorMetadataUtility.js'

vi.mock('../../websocket_server/Utilities/ConfigUtility.js', () => ({
	default: { JWT_SECRET_KEY: 'test-secret' },
}))

const SECRET = 'test-secret'
const ROOM_ID = '123'
const CREATED_AT = 1773915810534

const creator = {
	uid: 'alice',
	displayName: 'Alice',
	createdAt: CREATED_AT,
}

function scenePayload(customData = {}) {
	return {
		type: 'SCENE_UPDATE',
		payload: {
			elements: [{
				id: 'peer-element',
				type: 'rectangle',
				customData,
			}],
		},
	}
}

describe('creator metadata attestation', () => {
	it('uses a stable cross-runtime proof format', () => {
		expect(CreatorMetadataUtility.createProof(ROOM_ID, 'peer-element', creator, SECRET))
			.toBe('v1:31a3f15ad65d53e0b630d98a4fb2fbb9d629c4cb36992ba211c04f69304665bf')
	})

	it('uses a stable anonymous identity for public-link actors', () => {
		expect(CreatorMetadataUtility.getActor({ id: 'shared_token-value_random', name: 'Guest' })).toEqual({
			uid: 'public-link:e6c02a5742ea9d4d',
			displayName: 'Public link',
		})
	})

	it('replaces a forged creator with the authenticated socket actor', () => {
		const forged = scenePayload({
			creator: { uid: 'bob', displayName: 'Bob', createdAt: 1 },
			creatorProof: 'v1:'.padEnd(67, '0'),
			tableLock: { uid: 'bob', displayName: 'Bob', lockedAt: 10 },
			commentThread: { comments: [{ id: 'comment', author: 'Bob', text: 'hello' }] },
		})

		const canonical = CreatorMetadataUtility.canonicalizeBroadcastPayload(
			forged,
			ROOM_ID,
			{ uid: 'alice', displayName: 'Alice' },
			SECRET,
			CREATED_AT,
		)
		const customData = canonical.payload.elements[0].customData

		expect(customData.creator).toEqual(creator)
		expect(CreatorMetadataUtility.isValidProof(
			ROOM_ID,
			'peer-element',
			customData.creator,
			customData.creatorProof,
			SECRET,
		)).toBe(true)
		expect(customData.tableLock).toEqual(forged.payload.elements[0].customData.tableLock)
		expect(customData.commentThread).toEqual(forged.payload.elements[0].customData.commentThread)
	})

	it('preserves a valid creator proof when another user relays the element', () => {
		const proof = CreatorMetadataUtility.createProof(ROOM_ID, 'peer-element', creator, SECRET)
		const canonical = CreatorMetadataUtility.canonicalizeBroadcastPayload(
			scenePayload({ creator, creatorProof: proof }),
			ROOM_ID,
			{ uid: 'mallory', displayName: 'Mallory' },
			SECRET,
			CREATED_AT + 1,
		)

		expect(canonical.payload.elements[0].customData).toEqual({ creator, creatorProof: proof })
	})

	it('binds creator proofs to the board and element', () => {
		const proof = CreatorMetadataUtility.createProof(ROOM_ID, 'peer-element', creator, SECRET)

		expect(CreatorMetadataUtility.isValidProof(ROOM_ID, 'other-element', creator, proof, SECRET)).toBe(false)
		expect(CreatorMetadataUtility.isValidProof('456', 'peer-element', creator, proof, SECRET)).toBe(false)
	})

	it('attests scene payloads in the websocket relay', async () => {
		let emitted
		const socket = {
			id: 'socket-alice',
			rooms: new Set([ROOM_ID]),
			broadcast: {
				to: () => ({
					emit: (...args) => { emitted = args },
				}),
			},
		}
		const service = new ViewportService({
			io: {},
			sessionStore: {
				isReadOnly: async () => false,
				getSocketData: async () => ({ user: { id: 'alice', name: 'Alice' } }),
			},
		})
		const encoded = new TextEncoder().encode(JSON.stringify(scenePayload()))

		await service.serverBroadcast(socket, ROOM_ID, encoded, [])

		const relayed = JSON.parse(new TextDecoder().decode(emitted[1]))
		expect(emitted[0]).toBe('client-broadcast')
		expect(relayed.payload.elements[0].customData.creator.uid).toBe('alice')
	})

	it('relays restore reload requests without accepting scene data', async () => {
		let emitted
		const socket = {
			id: 'socket-alice',
			rooms: new Set([ROOM_ID]),
			broadcast: {
				to: () => ({
					emit: (...args) => { emitted = args },
				}),
			},
		}
		const service = new ViewportService({
			io: {},
			sessionStore: { isReadOnly: async () => false },
		})
		const reload = {
			type: 'SCENE_RESTORE',
			payload: { reloadFromServer: true },
		}
		const encoded = new TextEncoder().encode(JSON.stringify(reload))

		await service.serverBroadcast(socket, ROOM_ID, encoded, [])

		expect(JSON.parse(new TextDecoder().decode(emitted[1]))).toEqual(reload)
	})

	it('rejects restore payloads containing client-provided scene data', async () => {
		let emitted
		const socket = {
			id: 'socket-alice',
			rooms: new Set([ROOM_ID]),
			broadcast: {
				to: () => ({
					emit: (...args) => { emitted = args },
				}),
			},
		}
		const service = new ViewportService({
			io: {},
			sessionStore: { isReadOnly: async () => false },
		})
		const encoded = new TextEncoder().encode(JSON.stringify({
			type: 'SCENE_RESTORE',
			payload: {
				reloadFromServer: true,
				elements: [{ id: 'forged', customData: { creator: { uid: 'bob' } } }],
			},
		}))

		await service.serverBroadcast(socket, ROOM_ID, encoded, [])

		expect(emitted).toBeUndefined()
	})
})
