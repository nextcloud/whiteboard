/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

type Listener = (...args: unknown[]) => void

type ListenerSocket = {
	on: (event: string, listener: Listener) => unknown
	off: (event: string, listener: Listener) => unknown
}

/**
 * Adds listeners to a socket that other code also listens on.
 *
 * @param socket the shared socket
 * @param listeners listener per event
 * @return a function that removes exactly these listeners from this socket
 */
export function addSocketListeners(socket: ListenerSocket, listeners: Record<string, Listener>): () => void {
	const added = Object.entries(listeners)
	added.forEach(([event, listener]) => socket.on(event, listener))
	return () => added.forEach(([event, listener]) => socket.off(event, listener))
}
