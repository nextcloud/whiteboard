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
		<NcSettingsSection :name="t('whiteboard', 'Organization library templates')">
			<p class="settings-help">
				{{ t('whiteboard', 'Upload .excalidrawlib files to make reusable library items available when users create a new whiteboard. New boards start with an empty canvas and copied library items. Changes affect only future whiteboards.') }}
			</p>
			<input ref="globalLibraryTemplateInput"
				class="hidden-file-input"
				type="file"
				accept=".excalidrawlib"
				@change="uploadGlobalLibraryTemplate">
			<NcButton :disabled="uploadingGlobalLibraryTemplate"
				@click="selectGlobalLibraryTemplateFile">
				{{ uploadingGlobalLibraryTemplate ? t('whiteboard', 'Uploading…') : t('whiteboard', 'Upload library template') }}
			</NcButton>

			<NcNoteCard v-if="loadingGlobalLibraryTemplates" class="library-template-note" type="info">
				<template #icon>
					<NcLoadingIcon />
				</template>
				{{ t('whiteboard', 'Loading organization library templates…') }}
			</NcNoteCard>
			<p v-else-if="globalLibraryTemplates.length === 0" class="settings-help library-template-empty">
				{{ t('whiteboard', 'No organization library templates yet. Upload an .excalidrawlib file to let users start new whiteboards with reusable library items.') }}
			</p>
			<ul v-else class="library-template-list">
				<li v-for="template in globalLibraryTemplates"
					:key="template.templateName"
					class="library-template-row">
					<div class="library-template-info">
						<strong>{{ template.templateName }}</strong>
						<span>{{ formatLibraryItemCount(template.itemCount) }}</span>
					</div>
					<NcButton type="tertiary"
						:aria-label="t('whiteboard', 'Delete library template {name}', { name: template.templateName })"
						:disabled="deletingGlobalLibraryTemplate === template.templateName"
						@click="deleteGlobalLibraryTemplate(template.templateName)">
						{{ t('whiteboard', 'Delete') }}
					</NcButton>
				</li>
			</ul>
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
import { t, n } from '@nextcloud/l10n'
import { showError, showSuccess } from '@nextcloud/dialogs'

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
			globalLibraryTemplates: [],
			loadingGlobalLibraryTemplates: false,
			uploadingGlobalLibraryTemplate: false,
			deletingGlobalLibraryTemplate: null,
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
		this.fetchGlobalLibraryTemplates()
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
		async fetchGlobalLibraryTemplates() {
			this.loadingGlobalLibraryTemplates = true
			try {
				const { data } = await axios.get(generateUrl('/apps/whiteboard/settings/global-library'))
				this.globalLibraryTemplates = Array.isArray(data.templates) ? data.templates : []
			} catch (error) {
				showError(this.getErrorMessage(error, t('whiteboard', 'Failed to load organization library templates.')))
			} finally {
				this.loadingGlobalLibraryTemplates = false
			}
		},
		selectGlobalLibraryTemplateFile() {
			this.$refs.globalLibraryTemplateInput.click()
		},
		async uploadGlobalLibraryTemplate(event) {
			const file = event.target.files?.[0]
			if (!file) {
				return
			}

			const formData = new FormData()
			formData.append('file', file)
			this.uploadingGlobalLibraryTemplate = true
			try {
				const { data } = await axios.post(generateUrl('/apps/whiteboard/settings/global-library'), formData)
				const template = data?.template
				if (template?.templateName && Number.isFinite(template?.itemCount)) {
					showSuccess(t('whiteboard', 'Uploaded "{name}" with {items}.', {
						name: template.templateName,
						items: this.formatLibraryItemCount(template.itemCount),
					}))
				} else {
					showSuccess(t('whiteboard', 'Organization library template uploaded.'))
				}
				await this.fetchGlobalLibraryTemplates()
			} catch (error) {
				showError(this.getErrorMessage(error, t('whiteboard', 'Failed to upload organization library template.')))
			} finally {
				this.uploadingGlobalLibraryTemplate = false
				event.target.value = ''
			}
		},
		async deleteGlobalLibraryTemplate(templateName) {
			if (!window.confirm(t('whiteboard', 'Delete "{name}"? This removes the library template from the new whiteboard picker. Existing whiteboards that started from it are not affected.', { name: templateName }))) {
				return
			}

			this.deletingGlobalLibraryTemplate = templateName
			try {
				await axios.delete(`${generateUrl('/apps/whiteboard/settings/global-library')}/${encodeURIComponent(templateName)}`)
				showSuccess(t('whiteboard', 'Organization library template deleted.'))
				await this.fetchGlobalLibraryTemplates()
			} catch (error) {
				showError(this.getErrorMessage(error, t('whiteboard', 'Failed to delete organization library template.')))
			} finally {
				this.deletingGlobalLibraryTemplate = null
			}
		},
		getErrorMessage(error, fallback) {
			return error?.response?.data?.message || fallback
		},
		formatLibraryItemCount(count) {
			return n('whiteboard', '%n library item', '%n library items', count)
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

.hidden-file-input {
	display: none;
}

.library-template-note,
.library-template-empty,
.library-template-list {
	margin-top: calc(var(--default-grid-baseline) * 3);
}

.library-template-list {
	max-width: 700px;
	padding: 0;
	list-style: none;
}

.library-template-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: calc(var(--default-grid-baseline) * 4);
	padding: calc(var(--default-grid-baseline) * 2) 0;
	border-bottom: 1px solid var(--color-border);
}

.library-template-info {
	display: flex;
	flex-direction: column;
	gap: calc(var(--default-grid-baseline) * 0.5);
}

.library-template-info span {
	color: var(--color-text-maxcontrast);
	font-size: 0.875rem;
}

</style>
