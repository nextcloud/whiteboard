/**
 * SPDX-FileCopyrightText: 2019 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import AdminSettings from './components/AdminSettings.vue'
import { mountVueComponent } from './utils/vue'
import '@nextcloud/dialogs/style.css'

const element = document.getElementById('admin-vue')
if (element) {
	mountVueComponent(AdminSettings, element)
}
