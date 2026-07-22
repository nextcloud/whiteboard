/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import PersonalSettings from './components/PersonalSettings.vue'
import { mountVueComponent } from './utils/vue'
import '@nextcloud/dialogs/style.css'

const element = document.getElementById('personal-vue')
if (element) {
	mountVueComponent(PersonalSettings, element)
}
