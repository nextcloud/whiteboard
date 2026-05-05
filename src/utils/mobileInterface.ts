/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

declare global {
	interface Window {
		DirectEditingMobileInterface?: {
			[key: string]: (arg?: string) => void
		}
		webkit?: {
			messageHandlers?: {
				DirectEditingMobileInterface?: {
					postMessage: (message: unknown) => void
				}
			}
		}
	}
}

export function callMobileMessage(messageName: string, attributes?: unknown): void {
	let message: unknown = messageName
	if (typeof attributes !== 'undefined') {
		message = {
			MessageName: messageName,
			Values: attributes,
		}
	}

	let attributesString: string | null = null
	try {
		attributesString = JSON.stringify(attributes)
	} catch {
		attributesString = null
	}

	if (window.DirectEditingMobileInterface
		&& typeof window.DirectEditingMobileInterface[messageName] === 'function') {
		if (attributesString === null || typeof attributesString === 'undefined') {
			window.DirectEditingMobileInterface[messageName]()
		} else {
			window.DirectEditingMobileInterface[messageName](attributesString)
		}
	}

	if (window.webkit?.messageHandlers?.DirectEditingMobileInterface) {
		window.webkit.messageHandlers.DirectEditingMobileInterface.postMessage(message)
	}

	window.postMessage(message)
}
