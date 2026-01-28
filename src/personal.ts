/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import Vue from 'vue'
import { t, n } from '@nextcloud/l10n'

import PersonalSettings from './components/PersonalSettings.vue'

Vue.prototype.t = t
Vue.prototype.n = n

/* eslint-disable-next-line no-new */
new Vue({
	render: h => h(PersonalSettings, {}),
}).$mount('#personal-vue')
