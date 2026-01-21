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
				<NcTextField :label="t('whiteboard', 'Max image size (MB)')"
					:value.sync="maxFileSize"
					:helper-text="maxFileSizeHelperText"
					@blur="saveMaxFileSize" />
			</p>
			<p v-if="wsLimitHelperText" class="settings-help">
				{{ wsLimitHelperText }}
			</p>
			<NcNoteCard v-if="maxFileSizeNotice" :type="maxFileSizeNotice.type">
				{{ maxFileSizeNotice.message }}
			</NcNoteCard>
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
import { t } from '@nextcloud/l10n'
import { showError } from '@nextcloud/dialogs'

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
			wsMaxUploadFileSizeBytes: null,
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
		wsLimitMb() {
			if (!this.wsMaxUploadFileSizeBytes) {
				return null
			}
			return this.wsMaxUploadFileSizeBytes / 1e6
		},
		maxFileSizeHelperText() {
			return t('whiteboard', 'Per image added to the board (original file size).')
		},
		wsLimitHelperText() {
			if (this.wsLimitMb) {
				return t('whiteboard', 'WebSocket payload cap: {limit} MB (MAX_UPLOAD_FILE_SIZE on collaboration server).', { limit: this.wsLimitMb.toFixed(1) })
			}
			if (this.serverUrl) {
				return t('whiteboard', 'WebSocket payload cap set by MAX_UPLOAD_FILE_SIZE on the collaboration server.')
			}
			return null
		},
		maxFileSizeNotice() {
			const maxFileSize = Number(this.maxFileSize)
			if (!Number.isFinite(maxFileSize) || maxFileSize <= 0) {
				return {
					type: 'error',
					message: t('whiteboard', 'Enter a positive number of MB.'),
				}
			}

			if (!this.wsMaxUploadFileSizeBytes) {
				return null
			}

			if (this.wsLimitMb && maxFileSize > this.wsLimitMb) {
				return {
					type: 'error',
					message: t('whiteboard', 'Exceeds WebSocket payload limit ({limit} MB). Images may not sync.', { limit: this.wsLimitMb.toFixed(1) }),
				}
			}

			return null
		},
	},
	mounted() {
		this.callSettings({
			serverUrl: this.serverUrl,
		})
		this.verifyConnection({ jwt: loadState('whiteboard', 'jwt', '') })
		this.fetchWebsocketLimits()
	},
	methods: {
		async submit() {
			const data = await this.callSettings({
				serverUrl: this.serverUrl,
				secret: this.secret,
				maxFileSize: this.maxFileSize,
			})
			await this.verifyConnection(data)
			await this.fetchWebsocketLimits()
		},
		async saveMaxFileSize() {
			const maxFileSize = Number(this.maxFileSize)
			if (!Number.isFinite(maxFileSize) || maxFileSize <= 0) {
				showError(t('whiteboard', 'Max image size must be a positive number.'))
				return
			}
			if (this.wsLimitMb && maxFileSize > this.wsLimitMb) {
				showError(t('whiteboard', 'Max image size exceeds the WebSocket payload limit ({limit} MB).', { limit: this.wsLimitMb.toFixed(1) }))
				return
			}
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
		async fetchWebsocketLimits() {
			if (!this.serverUrl) {
				this.wsMaxUploadFileSizeBytes = null
				return
			}

			let statusUrl
			try {
				const url = new URL(this.serverUrl)
				const pathPrefix = url.pathname.replace(/\/$/, '')
				const protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol
				statusUrl = `${protocol}//${url.host}${pathPrefix}/status`
			} catch (error) {
				this.wsMaxUploadFileSizeBytes = null
				return
			}

			try {
				const response = await fetch(statusUrl, { method: 'GET', mode: 'cors', credentials: 'omit' })
				if (!response.ok) {
					throw new Error(`Status ${response.status}`)
				}
				const data = await response.json()
				this.wsMaxUploadFileSizeBytes = data?.config?.maxUploadFileSizeBytes ?? null
			} catch (error) {
				this.wsMaxUploadFileSizeBytes = null
			}
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
		t,
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

.settings-help {
	margin-top: calc(var(--default-grid-baseline) * -3);
	margin-bottom: calc(var(--default-grid-baseline) * 4);
	color: var(--color-text-maxcontrast);
	font-size: 0.875rem;
}
</style>
