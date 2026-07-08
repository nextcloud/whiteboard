/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { NcReferenceList } from '@nextcloud/vue/components/NcRichText'
import { createElement } from 'react'

import VueWrapper from './VueWrapper'

/**
 *
 * @param props props
 * @param props.link link to display in embedable
 */
export default function(props: { link: string | null }) {
	const referenceProps = { text: props.link ?? '', limit: 1, interactive: true }
	return createElement(VueWrapper, { componentProps: referenceProps, component: NcReferenceList })
}
