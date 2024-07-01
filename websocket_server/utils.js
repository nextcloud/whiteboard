/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const convertStringToArrayBuffer = (string) => new TextEncoder().encode(string).buffer
export const convertArrayBufferToString = (arrayBuffer) => new TextDecoder().decode(arrayBuffer)
export const parseBooleanFromEnv = (value) => value === 'true'
