/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import crypto from 'crypto'

const CREATOR_PROOF_DOMAIN = 'whiteboard.creator.v1'
const CREATOR_PROOF_PREFIX = 'v1:'
const SCENE_BROADCAST_TYPES = new Set([
	'SCENE_INIT',
	'SCENE_UPDATE',
])

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodeField(value) {
	return Buffer.from(value, 'utf8').toString('base64url')
}

function isValidCreator(creator) {
	return isRecord(creator)
		&& typeof creator.uid === 'string'
		&& creator.uid !== ''
		&& typeof creator.displayName === 'string'
		&& Number.isSafeInteger(creator.createdAt)
		&& creator.createdAt > 0
}

function buildProofPayload(roomId, elementId, creator) {
	return [
		CREATOR_PROOF_DOMAIN,
		encodeField(String(roomId)),
		encodeField(elementId),
		encodeField(creator.uid),
		encodeField(creator.displayName),
		String(creator.createdAt),
	].join('.')
}

export default class CreatorMetadataUtility {
	static getActor(user) {
		if (!isRecord(user) || typeof user.id !== 'string' || user.id === '') {
			return null
		}

		const publicShareMatch = /^shared_([^_]+)_/.exec(user.id)
		if (publicShareMatch) {
			return {
				uid: `public-link:${crypto.createHash('sha256').update(publicShareMatch[1]).digest('hex').slice(0, 16)}`,
				displayName: 'Public link',
			}
		}

		return {
			uid: user.id,
			displayName: typeof user.name === 'string' && user.name !== '' ? user.name : user.id,
		}
	}

	static createProof(roomId, elementId, creator, secret) {
		const signature = crypto
			.createHmac('sha256', secret)
			.update(buildProofPayload(roomId, elementId, creator))
			.digest('hex')

		return `${CREATOR_PROOF_PREFIX}${signature}`
	}

	static isValidProof(roomId, elementId, creator, proof, secret) {
		if (!isValidCreator(creator)
			|| typeof proof !== 'string'
			|| !/^v1:[a-f0-9]{64}$/.test(proof)) {
			return false
		}

		const expected = CreatorMetadataUtility.createProof(roomId, elementId, creator, secret)
		return crypto.timingSafeEqual(Buffer.from(proof), Buffer.from(expected))
	}

	static isSceneBroadcastPayload(payload) {
		return isRecord(payload)
			&& SCENE_BROADCAST_TYPES.has(payload.type)
			&& isRecord(payload.payload)
			&& Array.isArray(payload.payload.elements)
	}

	static isSceneRestoreReloadPayload(payload) {
		return isRecord(payload)
			&& payload.type === 'SCENE_RESTORE'
			&& isRecord(payload.payload)
			&& payload.payload.reloadFromServer === true
			&& Object.keys(payload.payload).length === 1
	}

	static canonicalizeBroadcastPayload(payload, roomId, actor, secret, createdAt = Date.now()) {
		if (!CreatorMetadataUtility.isSceneBroadcastPayload(payload)) {
			return payload
		}

		const elements = payload.payload.elements.map((element) => {
			if (!isRecord(element)) {
				return element
			}

			const customData = isRecord(element.customData) ? { ...element.customData } : {}
			if (typeof element.id !== 'string' || element.id === '') {
				delete customData.creator
				delete customData.creatorProof
				const sanitized = { ...element }
				if (Object.keys(customData).length === 0) {
					delete sanitized.customData
				} else {
					sanitized.customData = customData
				}
				return sanitized
			}

			if (CreatorMetadataUtility.isValidProof(
				roomId,
				element.id,
				customData.creator,
				customData.creatorProof,
				secret,
			)) {
				return {
					...element,
					customData: {
						...customData,
						creator: {
							uid: customData.creator.uid,
							displayName: customData.creator.displayName,
							createdAt: customData.creator.createdAt,
						},
					},
				}
			}

			const creator = {
				uid: actor.uid,
				displayName: actor.displayName,
				createdAt,
			}

			return {
				...element,
				customData: {
					...customData,
					creator,
					creatorProof: CreatorMetadataUtility.createProof(roomId, element.id, creator, secret),
				},
			}
		})

		return {
			...payload,
			payload: {
				...payload.payload,
				elements,
			},
		}
	}
}
