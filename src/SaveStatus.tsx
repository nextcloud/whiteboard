/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import SaveStatus from './SaveStatus.vue'
import VueWrapper from './VueWrapper'

export default function(props:{saving: Boolean}) {
	return React.createElement(VueWrapper, { componentProps: props, component: SaveStatus })
}
