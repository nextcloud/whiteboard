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
					<NcTextField v-model="serverUrl"
						:label="t('whiteboard', 'WebSocket server URL')"
						:helper-text="t('whiteboard', 'URL where the WebSocket server for real-time collaboration is running. Must be accessible from users\' browsers.')" />
				</p>
				<p>
					<NcPasswordField v-model="secret"
						:label="t('whiteboard', 'Shared secret')"
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
		<NcSettingsSection :name="t('whiteboard', 'Organization templates')"
			:description="t('whiteboard', 'Templates shared with everyone in this organization.')">
			<NcNoteCard v-if="!orgTemplatesSupported" type="warning">
				{{ t('whiteboard', 'Organization templates require Nextcloud 30 or later. Upgrade to make them available in the "New whiteboard" picker.') }}
			</NcNoteCard>
			<div v-if="orgTemplatesSupported" class="org-template-group">
				<h3 class="org-template-heading">
					{{ t('whiteboard', 'Libraries') }}
				</h3>
				<p class="settings-help">
					{{ t('whiteboard', 'Shape libraries shown to everyone as read-only sections in the whiteboard library panel. Upload an .excalidrawlib file; its shapes appear in every user’s library alongside their own.') }}
				</p>
				<input ref="orgLibraryInput"
					class="hidden-file-input"
					type="file"
					accept=".excalidrawlib"
					@change="uploadOrgLibrary">
				<NcButton :disabled="uploadingOrgLibrary"
					@click="selectOrgLibraryFile">
					{{ uploadingOrgLibrary ? t('whiteboard', 'Uploading…') : t('whiteboard', 'Upload library') }}
				</NcButton>

				<NcNoteCard v-if="loadingOrgLibraries" class="org-library-note" type="info">
					<template #icon>
						<NcLoadingIcon />
					</template>
					{{ t('whiteboard', 'Loading organization libraries…') }}
				</NcNoteCard>
				<p v-else-if="orgLibraries.length === 0" class="settings-help org-library-empty">
					{{ t('whiteboard', 'No organization libraries yet. Upload an .excalidrawlib file to share a set of shapes with everyone.') }}
				</p>
				<ul v-else class="org-library-list">
					<li v-for="library in orgLibraries"
						:key="library.name"
						class="org-library-row">
						<div class="org-library-info">
							<strong>{{ library.name }}</strong>
							<span>{{ formatItemCount(library) }}</span>
						</div>
						<NcButton variant="tertiary"
							:aria-label="t('whiteboard', 'Delete library {name}', { name: library.name })"
							:disabled="deletingOrgLibrary === library.name"
							@click="deleteOrgLibrary(library.name)">
							{{ t('whiteboard', 'Delete') }}
						</NcButton>
					</li>
				</ul>
			</div>
			<div v-if="orgTemplatesSupported" class="org-template-group">
				<h3 class="org-template-heading">
					{{ t('whiteboard', 'Canvases') }}
				</h3>
				<p class="settings-help">
					{{ t('whiteboard', 'Whiteboard canvases available to everyone in the "New whiteboard" picker. Upload a .whiteboard file; new boards created from it start with a copy of its content.') }}
				</p>
				<input ref="orgCanvasTemplateInput"
					class="hidden-file-input"
					type="file"
					accept=".whiteboard"
					@change="uploadOrgCanvasTemplate">
				<NcButton :disabled="uploadingOrgCanvasTemplate"
					@click="selectOrgCanvasTemplateFile">
					{{ uploadingOrgCanvasTemplate ? t('whiteboard', 'Uploading…') : t('whiteboard', 'Upload canvas') }}
				</NcButton>

				<NcNoteCard v-if="loadingOrgCanvasTemplates" class="org-library-note" type="info">
					<template #icon>
						<NcLoadingIcon />
					</template>
					{{ t('whiteboard', 'Loading organization canvases…') }}
				</NcNoteCard>
				<p v-else-if="orgCanvasTemplates.length === 0" class="settings-help org-library-empty">
					{{ t('whiteboard', 'No organization canvases yet. Upload a .whiteboard file to share a starting board with everyone.') }}
				</p>
				<ul v-else class="org-library-list">
					<li v-for="template in orgCanvasTemplates"
						:key="template.name"
						class="org-library-row">
						<div class="org-library-info">
							<strong>{{ template.name }}</strong>
							<span>{{ formatElementCount(template) }}</span>
						</div>
						<NcButton variant="tertiary"
							:aria-label="t('whiteboard', 'Delete canvas {name}', { name: template.name })"
							:disabled="deletingOrgCanvasTemplate === template.name"
							@click="deleteOrgCanvasTemplate(template.name)">
							{{ t('whiteboard', 'Delete') }}
						</NcButton>
					</li>
				</ul>
			</div>
		</NcSettingsSection>
		<NcSettingsSection :name="t('whiteboard', 'Advanced settings')">
			<p>
				<NcTextField v-model="maxFileSize"
					:label="t('whiteboard', 'Max image size (MB)')"
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
import NcTextField from '@nextcloud/vue/components/NcTextField'
import NcPasswordField from '@nextcloud/vue/components/NcPasswordField'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcLoadingIcon from '@nextcloud/vue/components/NcLoadingIcon'
import NcNoteCard from '@nextcloud/vue/components/NcNoteCard'
import NcSettingsSection from '@nextcloud/vue/components/NcSettingsSection'
import { loadState } from '@nextcloud/initial-state'
import { generateUrl } from '@nextcloud/router'
import { t, n } from '@nextcloud/l10n'
import { showError, showSuccess } from '@nextcloud/dialogs'

export default {
	name: 'AdminSettings',
	components: {
		NcTextField,
		NcPasswordField,
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
			orgTemplatesSupported: loadState('whiteboard', 'orgTemplatesSupported', true),
			wsMaxUploadFileSizeBytes: null,
			validConnection: undefined,
			connectionError: undefined,
			loadingSettings: false,
			loadingSocket: false,
			setupCheck: null,
			orgLibraries: [],
			loadingOrgLibraries: false,
			uploadingOrgLibrary: false,
			deletingOrgLibrary: null,
			orgCanvasTemplates: [],
			loadingOrgCanvasTemplates: false,
			uploadingOrgCanvasTemplate: false,
			deletingOrgCanvasTemplate: null,
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
		if (this.orgTemplatesSupported) {
			this.fetchOrgLibraries()
			this.fetchOrgCanvasTemplates()
		}
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
		async fetchOrgLibraries() {
			this.loadingOrgLibraries = true
			try {
				const { data } = await axios.get(generateUrl('/apps/whiteboard/settings/org-library'))
				this.orgLibraries = Array.isArray(data.libraries) ? data.libraries : []
			} catch (error) {
				showError(this.getErrorMessage(error, t('whiteboard', 'Failed to load organization libraries.')))
			} finally {
				this.loadingOrgLibraries = false
			}
		},
		selectOrgLibraryFile() {
			this.$refs.orgLibraryInput.click()
		},
		async uploadOrgLibrary(event) {
			const file = event.target.files?.[0]
			if (!file) {
				return
			}

			const formData = new FormData()
			formData.append('file', file)
			this.uploadingOrgLibrary = true
			try {
				const { data } = await axios.post(generateUrl('/apps/whiteboard/settings/org-library'), formData)
				const library = data?.library
				if (library?.name) {
					showSuccess(t('whiteboard', 'Uploaded library "{name}".', {
						name: library.name,
					}))
				} else {
					showSuccess(t('whiteboard', 'Organization library uploaded.'))
				}
				await this.fetchOrgLibraries()
			} catch (error) {
				showError(this.getErrorMessage(error, t('whiteboard', 'Failed to upload organization library.')))
			} finally {
				this.uploadingOrgLibrary = false
				event.target.value = ''
			}
		},
		async deleteOrgLibrary(name) {
			if (!window.confirm(t('whiteboard', 'Delete organization library "{name}"? It will no longer appear in users\' library panels.', { name }))) {
				return
			}

			this.deletingOrgLibrary = name
			try {
				await axios.delete(`${generateUrl('/apps/whiteboard/settings/org-library')}/${encodeURIComponent(name)}`)
				showSuccess(t('whiteboard', 'Organization library deleted.'))
				await this.fetchOrgLibraries()
			} catch (error) {
				showError(this.getErrorMessage(error, t('whiteboard', 'Failed to delete organization library.')))
			} finally {
				this.deletingOrgLibrary = null
			}
		},
		async fetchOrgCanvasTemplates() {
			this.loadingOrgCanvasTemplates = true
			try {
				const { data } = await axios.get(generateUrl('/apps/whiteboard/settings/org-canvas-template'))
				this.orgCanvasTemplates = Array.isArray(data.canvasTemplates) ? data.canvasTemplates : []
			} catch (error) {
				showError(this.getErrorMessage(error, t('whiteboard', 'Failed to load organization canvases.')))
			} finally {
				this.loadingOrgCanvasTemplates = false
			}
		},
		selectOrgCanvasTemplateFile() {
			this.$refs.orgCanvasTemplateInput.click()
		},
		async uploadOrgCanvasTemplate(event) {
			const file = event.target.files?.[0]
			if (!file) {
				return
			}

			const formData = new FormData()
			formData.append('file', file)
			this.uploadingOrgCanvasTemplate = true
			try {
				const { data } = await axios.post(generateUrl('/apps/whiteboard/settings/org-canvas-template'), formData)
				const template = data?.canvasTemplate
				if (template?.name) {
					showSuccess(t('whiteboard', 'Uploaded canvas "{name}".', {
						name: template.name,
					}))
				} else {
					showSuccess(t('whiteboard', 'Organization canvas uploaded.'))
				}
				await this.fetchOrgCanvasTemplates()
			} catch (error) {
				showError(this.getErrorMessage(error, t('whiteboard', 'Failed to upload organization canvas.')))
			} finally {
				this.uploadingOrgCanvasTemplate = false
				event.target.value = ''
			}
		},
		async deleteOrgCanvasTemplate(name) {
			if (!window.confirm(t('whiteboard', 'Delete organization canvas "{name}"? It will no longer appear in the "New whiteboard" picker. Boards already created from it keep their content.', { name }))) {
				return
			}

			this.deletingOrgCanvasTemplate = name
			try {
				await axios.delete(`${generateUrl('/apps/whiteboard/settings/org-canvas-template')}/${encodeURIComponent(name)}`)
				showSuccess(t('whiteboard', 'Organization canvas deleted.'))
				await this.fetchOrgCanvasTemplates()
			} catch (error) {
				showError(this.getErrorMessage(error, t('whiteboard', 'Failed to delete organization canvas.')))
			} finally {
				this.deletingOrgCanvasTemplate = null
			}
		},
		getErrorMessage(error, fallback) {
			return error?.response?.data?.message || fallback
		},
		formatItemCount(library) {
			return n('whiteboard', '%n library item', '%n library items', Number(library.itemCount) || 0)
		},
		formatElementCount(template) {
			return n('whiteboard', '%n element', '%n elements', Number(template.elementCount) || 0)
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

.org-template-group {
	margin-bottom: calc(var(--default-grid-baseline) * 8);
}

.org-template-group:last-child {
	margin-bottom: 0;
}

.org-template-heading {
	margin: 0 0 calc(var(--default-grid-baseline) * 1);
	font-size: 1.0625rem;
	font-weight: 600;
}

.org-template-group .settings-help {
	margin-top: 0;
}

.org-library-note,
.org-library-empty,
.org-library-list {
	margin-top: calc(var(--default-grid-baseline) * 3);
}

.org-library-list {
	max-width: 700px;
	padding: 0;
	list-style: none;
	border: 1px solid var(--color-border);
	border-radius: var(--border-radius-large);
	overflow: hidden;
}

.org-library-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: calc(var(--default-grid-baseline) * 4);
	padding: calc(var(--default-grid-baseline) * 2) calc(var(--default-grid-baseline) * 3);
	border-bottom: 1px solid var(--color-border);
}

.org-library-row:last-child {
	border-bottom: none;
}

.org-library-row:hover {
	background-color: var(--color-background-hover);
}

.org-library-info {
	display: flex;
	flex-direction: column;
	gap: calc(var(--default-grid-baseline) * 0.5);
}

.org-library-info span {
	color: var(--color-text-maxcontrast);
	font-size: 0.875rem;
}

</style>
