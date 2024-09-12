/**
 * SPDX-FileCopyrightText: 2019 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import Vue from 'vue'
import AdminSettings from './settings/Settings.vue'
import { t, n } from '@nextcloud/l10n'

Vue.prototype.t = t
Vue.prototype.n = n

/* eslint-disable-next-line no-new */
new Vue({
	render: h => h(AdminSettings, {}),
}).$mount('#admin-vue')
