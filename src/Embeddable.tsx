/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { NcReferenceList } from '@nextcloud/vue/dist/Components/NcRichText.js'

import VueWrapper from './VueWrapper'

/**
 *
 * @param props componentProps and component to be rendered in Vue
 */
export default function(props) {
	const referenceProps = { text: props.link, limit: '1', interactive: true }
	return React.createElement(VueWrapper, { componentProps: referenceProps, component: NcReferenceList })
}
