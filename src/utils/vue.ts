/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { App, Component } from 'vue'

import { n, t } from '@nextcloud/l10n'
import { createApp, h, reactive } from 'vue'

export type MountedVueComponent = {
	app: App<Element>
	props: Record<string, unknown>
	unmount: () => void
}

type MountVueComponentOptions = {
	removeTargetOnUnmount?: boolean
}

function eventPropName(eventName: string): string {
	return `on${eventName.charAt(0).toUpperCase()}${eventName.slice(1)}`
}

export function mountVueComponent(component: Component, target: Element, initialProps: Record<string, unknown> = {}, listeners: Record<string, (...args: never[]) => void> = {}, options: MountVueComponentOptions = {}): MountedVueComponent {
	const props = reactive({ ...initialProps })
	const listenerProps = Object.fromEntries(Object.entries(listeners).map(([name, listener]) => [eventPropName(name), listener]))

	const app = createApp({
		render() {
			return h(component, {
				...props,
				...listenerProps,
			})
		},
	})

	app.config.globalProperties.t = t
	app.config.globalProperties.n = n
	app.mount(target)

	return {
		app,
		props,
		unmount: () => {
			app.unmount()
			if (options.removeTargetOnUnmount) {
				target.remove()
			}
		},
	}
}
