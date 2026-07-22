/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { createApp, h, reactive, type App, type Component } from 'vue'
import { n, t } from '@nextcloud/l10n'

export type MountedVueComponent = {
	app: App<Element>
	props: Record<string, unknown>
	unmount: () => void
}

type MountVueComponentOptions = {
	removeTargetOnUnmount?: boolean
}

const eventPropName = (eventName: string): string =>
	`on${eventName.charAt(0).toUpperCase()}${eventName.slice(1)}`

export const mountVueComponent = (
	component: Component,
	target: Element,
	initialProps: Record<string, unknown> = {},
	listeners: Record<string, (...args: never[]) => void> = {},
	options: MountVueComponentOptions = {},
): MountedVueComponent => {
	const props = reactive({ ...initialProps })
	const listenerProps = Object.fromEntries(
		Object.entries(listeners).map(([name, listener]) => [eventPropName(name), listener]),
	)

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
