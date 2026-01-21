/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import Vue from 'vue'
import { t } from '@nextcloud/l10n'
import { Icon } from '@mdi/react'
import { mdiAccountPlusOutline } from '@mdi/js'

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

	const url = componentProps.text

	// Generate a link to open the details tab for sharing settings
	let linkToOpenSharingDetails = ''
	let visibleWarning = ''
	if (url.includes('/f/')) {
		linkToOpenSharingDetails = url + '?opendetails=true&openfile=false'
		visibleWarning = t('whiteboard', 'Please share the file with users; otherwise, they will not be able to see it.')
	} else if (url.includes('/deck/board/')) {
		linkToOpenSharingDetails = url + '/details'
		visibleWarning = t('whiteboard', 'Please share the board with users; otherwise, they will not be able to see it.')
	}

	const embedContentStyle = {
		minHeight: 'max(400px, 50vh)',
		height: '100%',
		width: '100%',
	}

	if (!linkToOpenSharingDetails) {
		return <div id="vue-component" ref={vueRef} className="whiteboard-embed__content" style={embedContentStyle}></div>
	}

	return (
		<div className="whiteboard-embed__wrapper">
			<div
				className="whiteboard-embed__notice"
				style={{
					padding: '0.5rem',
					fontStyle: 'italic',
					color: '#666',
				}}>
				{visibleWarning}
				<a href={linkToOpenSharingDetails} target={'_blank'} style={{ marginLeft: '0.5rem' }}>
					<Icon path={mdiAccountPlusOutline} size={1} style={{ marginBottom: '-4px' }} />
				</a>
			</div>
			<div id="vue-component" ref={vueRef} className="whiteboard-embed__content" style={embedContentStyle}></div>
		</div>
	)
}

export default VueWrapper
