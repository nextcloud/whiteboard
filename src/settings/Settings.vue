<!--
  - SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<div class="section">
		<h3>{{ t('whiteboard', 'Whiteboard settings') }}</h3>

		<NcNoteCard v-if="!loading && setupCheck !== null" :type="setupCheck.severity">
			{{ setupCheck.description }}
		</NcNoteCard>
		<NcNoteCard v-else-if="!loading && validConnection === true" type="success">
			{{ t('whiteboard', 'Whiteboard backend server is configured and connected.') }}
		</NcNoteCard>
		<NcNoteCard v-else-if="!loading && validConnection === false" type="error">
			{{ t('whiteboard', 'Failed to verify the connection:') }} {{ connectionError }}
		</NcNoteCard>
		<NcNoteCard v-else type="info" :text="t('whiteboard', 'Verifying connection…')">
			<template #icon>
				<NcLoadingIcon />
			</template>
		</NcNoteCard>

		<p>
			{{ t('whiteboard', 'Whiteboard requires a separate collaboration server that is connected to Nextcloud.') }}
			<a href="https://github.com/nextcloud/whiteboard?tab=readme-ov-file#backend"
				rel="noreferrer noopener"
				target="_blank"
				class="external">{{ t('whiteboard', 'See the documentation on how to install it.') }}</a>
		</p>
		<form @submit.prevent="submit">
			<p>
				<NcTextField :label="t('whiteboard', 'Whiteboard server URL')"
					:value.sync="serverUrl" />
			</p>
			<p>
				<NcTextField :label="t('whiteboard', 'Shared secret')"
					:value.sync="secret" />
			</p>
			<p>
				<NcButton type="submit"
					:disabled="!serverUrl || loading"
					@click.prevent="submit">
					{{ t('whiteboard', 'Save settings') }}
				</NcButton>
			</p>
		</form>
	</div>
</template>
<script>
import axios from '@nextcloud/axios'
import { io } from 'socket.io-client'
import NcTextField from '@nextcloud/vue/dist/Components/NcTextField.js'
import NcButton from '@nextcloud/vue/dist/Components/NcButton.js'
import NcLoadingIcon from '@nextcloud/vue/dist/Components/NcLoadingIcon.js'
import NcNoteCard from '@nextcloud/vue/dist/Components/NcNoteCard.js'
import { loadState } from '@nextcloud/initial-state'
import { generateUrl } from '@nextcloud/router'

export default {
	name: 'Settings',
	components: {
		NcTextField,
		NcButton,
		NcLoadingIcon,
		NcNoteCard,
	},
	data() {
		return {
			serverUrl: loadState('whiteboard', 'url', ''),
			secret: loadState('whiteboard', 'secret', ''),
			validConnection: undefined,
			connectionError: undefined,
			loading: false,
			setupCheck: null,
		}
	},
	mounted() {
		this.callSettings()
		this.verifyConnection({ jwt: loadState('whiteboard', 'jwt', '') })
	},
	methods: {
		async submit() {
			const data = await this.callSettings({
				serverUrl: this.serverUrl,
				secret: this.secret,
			})
			await this.verifyConnection(data)
		},
		async callSettings(updateValues = {}) {
			this.loading = true
			const { data } = await axios.post(generateUrl('/apps/whiteboard/settings'), updateValues)
			this.setupCheck = data.check.severity !== 'success' ? data.check : null
			this.loading = false
			return data
		},
		async verifyConnection(data) {
			this.loading = true

			const url = new URL(this.serverUrl)
			const path = url.pathname.replace(/\/$/, '') + '/socket.io'

			const socket = io(url.origin, {
				path,
				withCredentials: true,
				auth: {
					secret: data.jwt,
				},
				transports: ['websocket'],
				timeout: 5000,
			})
			socket.on('connect', () => {
				this.validConnection = true
				this.connectionError = undefined
				this.loading = false
			})
			socket.on('connect_error', (error) => {
				this.validConnection = error.message === 'Connection verified'
				this.connectionError = this.validConnection === false ? error.message : undefined
				socket.close()
				this.loading = false
			})
			socket.connect()
		},
	},
}
</script>
<style scoped>
.section {
	max-width: 700px;
}

p {
	margin-bottom: calc(var(--default-grid-baseline) * 4);
}
</style>
