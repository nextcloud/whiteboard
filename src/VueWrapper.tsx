/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import Vue from 'vue'

const VueWrapper = function(
	{ componentProps, component }) {
	const vueRef = React.useRef(null)
	const [vueInstance, setVueInstance] = React.useState(undefined)

	React.useEffect(() => {
		/**
		 *
		 */
		async function createVueInstance() {
		}

		createVueInstance()

		setVueInstance(new Vue({
			el: vueRef.current,
			data() {
				return {
					props: componentProps,
				}
			},
			render(h) {
				return h(component, {
					props: this.props,
				})
			},
		}))

		return () => {
			vueInstance?.$destroy()
		}
	}, [])

	React.useEffect(() => {
		if (vueInstance) {
			const keys = Object.keys(componentProps)
			keys.forEach(key => { vueInstance.props[key] = componentProps[key] })
		}
	}, [Object.values(componentProps)])

	return <div id="vue-component" ref={vueRef}></div>
}

export default VueWrapper
