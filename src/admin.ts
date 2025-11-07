/**
 * SPDX-FileCopyrightText: 2019 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import Vue from 'vue'
import { t, n } from '@nextcloud/l10n'

import AdminSettings from './components/AdminSettings.vue'

Vue.prototype.t = t
Vue.prototype.n = n

/* eslint-disable-next-line no-new */
new Vue({
	render: h => h(AdminSettings, {}),
}).$mount('#admin-vue')
