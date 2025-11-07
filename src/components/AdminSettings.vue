<!--
  - SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<div>
		<NcSettingsSection :name="t('whiteboard', 'Real-time collaboration server')">
			<NcNoteCard v-if="!loading && setupCheck !== null" :type="setupCheck.severity">
				{{ setupCheck.description }}
			</NcNoteCard>
			<NcNoteCard v-else-if="!loading && validConnection === true" type="success">
				{{ t('whiteboard', 'WebSocket server for real-time collaboration is configured and connected.') }}
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
				{{ t('whiteboard', 'The WebSocket server handles real-time collaboration sessions between users. Basic whiteboard functionality works without it, but real-time collaboration requires this server to be running and accessible from users\' browsers.') }}
			</p>
			<p>
				<a href="https://github.com/nextcloud/whiteboard?tab=readme-ov-file#websocket-server-for-real-time-collaboration"
					rel="noreferrer noopener"
					target="_blank"
					class="external">{{ t('whiteboard', 'See the documentation on how to install and configure the WebSocket server.') }}</a>
			</p>
			<form @submit.prevent="submit">
				<p>
					<NcTextField :label="t('whiteboard', 'WebSocket server URL')"
						:value.sync="serverUrl"
						:helper-text="t('whiteboard', 'URL where the WebSocket server for real-time collaboration is running. Must be accessible from users\' browsers.')" />
				</p>
				<p>
					<NcTextField :label="t('whiteboard', 'Shared secret')"
						:value.sync="secret"
						:helper-text="t('whiteboard', 'JWT secret key shared between Nextcloud and the WebSocket server for secure authentication.')" />
				</p>
				<p>
					<NcButton type="submit"
						:disabled="!serverUrl || loading"
						@click.prevent="submit">
						{{ t('whiteboard', 'Save settings') }}
					</NcButton>
				</p>
			</form>
		</NcSettingsSection>
		<NcSettingsSection :name="t('whiteboard', 'Advanced settings')">
			<p>
				<NcTextField :label="t('whiteboard', 'Max file size')"
					:value.sync="maxFileSize"
					@blur="saveMaxFileSize" />
			</p>
		</NcSettingsSection>
	</div>
</template>
<script>
import axios from '@nextcloud/axios'
import { io } from 'socket.io-client'
import NcTextField from '@nextcloud/vue/dist/Components/NcTextField.js'
import NcButton from '@nextcloud/vue/dist/Components/NcButton.js'
import NcLoadingIcon from '@nextcloud/vue/dist/Components/NcLoadingIcon.js'
import NcNoteCard from '@nextcloud/vue/dist/Components/NcNoteCard.js'
import NcSettingsSection from '@nextcloud/vue/dist/Components/NcSettingsSection.js'
import { loadState } from '@nextcloud/initial-state'
import { generateUrl } from '@nextcloud/router'

export default {
	name: 'AdminSettings',
	components: {
		NcTextField,
		NcButton,
		NcLoadingIcon,
		NcNoteCard,
		NcSettingsSection,
	},
	data() {
		return {
			serverUrl: loadState('whiteboard', 'url', ''),
			secret: loadState('whiteboard', 'secret', ''),
			maxFileSize: loadState('whiteboard', 'maxFileSize', 10),
			validConnection: undefined,
			connectionError: undefined,
			loadingSettings: false,
			loadingSocket: false,
			setupCheck: null,
		}
	},
	computed: {
		loading() {
			return this.loadingSettings || this.loadingSocket
		},
	},
	mounted() {
		this.callSettings({
			serverUrl: this.serverUrl,
		})
		this.verifyConnection({ jwt: loadState('whiteboard', 'jwt', '') })
	},
	methods: {
		async submit() {
			const data = await this.callSettings({
				serverUrl: this.serverUrl,
				secret: this.secret,
				maxFileSize: this.maxFileSize,
			})
			await this.verifyConnection(data)
		},
		async saveMaxFileSize() {
			await this.callSettings({
				maxFileSize: this.maxFileSize,
			})
		},
		async callSettings(updateValues = {}) {
			this.loadingSettings = true
			const { data } = await axios.post(generateUrl('/apps/whiteboard/settings'), updateValues)
			if (data.check) {
				this.setupCheck = data.check.severity !== 'success' ? data.check : null
			}
			this.loadingSettings = false
			return data
		},
		async verifyConnection(data) {
			if (!data.jwt) {
				return
			}

			const url = new URL(this.serverUrl)
			const path = url.pathname.replace(/\/$/, '') + '/socket.io'

			this.loadingSocket = true
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
				this.loadingSocket = false
			})
			socket.on('connect_error', (error) => {
				this.validConnection = error.message === 'Connection verified'
				this.connectionError = this.validConnection === false ? error.message : undefined
				socket.close()
				this.loadingSocket = false
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
