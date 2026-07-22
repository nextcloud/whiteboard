/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Groups the native "New whiteboard" template picker into two labelled
 * sections — Personal (the blank board plus your own templates and saved
 * libraries) and Organization (admin-published ones) — and badges each tile
 * as Canvas template (full board copy) or Library (shape kit resolved live).
 *
 * Entry metadata comes from GET /apps/whiteboard/picker, a fileid -> {kind,
 * scope} map; the blank tile (fileid -1) needs no lookup.
 *
 * Intentionally dependency-free: this script is injected standalone into the
 * Files app, so importing @nextcloud/* (which drags in heavy shared chunks)
 * risks a module-load failure. Uses fetch + NC globals only.
 */

const WHITEBOARD_APP = 'whiteboard'

type Scope = 'personal' | 'org'
type Kind = 'canvas-template' | 'library'
type Entry = { kind: Kind; scope: Scope }

const ORDER: Scope[] = ['personal', 'org']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const oc = (): any => (globalThis as any).OC

function tr(text: string): string {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const translate = (globalThis as any).t
	return typeof translate === 'function' ? translate(WHITEBOARD_APP, text) : text
}

function heading(scope: Scope): string {
	return scope === 'personal' ? tr('Personal') : tr('Organization')
}

function badgeLabel(kind: Kind): string {
	return kind === 'library' ? tr('Library') : tr('Canvas')
}

let entries: Map<string, Entry> | null = null
let loadingEntries = false
// File ids that stayed unknown after a map refresh — don't refetch for them
// until the negative cache expires (a template saved after the last fetch
// becomes resolvable on the next picker open).
const unresolvedIds = new Set<string>()
let unresolvedAt = 0
const UNRESOLVED_RETRY_MS = 30_000

async function loadEntries(): Promise<Map<string, Entry>> {
	const map = new Map<string, Entry>()
	try {
		const OC = oc()
		// eslint-disable-next-line @nextcloud/no-deprecations -- Standalone Files script avoids @nextcloud/router imports.
		const url = OC?.generateUrl?.('/apps/whiteboard/picker') ?? '/index.php/apps/whiteboard/picker'
		const response = await globalThis.fetch(url, {
			headers: {
				Accept: 'application/json',
				requesttoken: OC?.requestToken ?? '',
			},
			credentials: 'include',
		})
		if (!response.ok) {
			return map
		}
		const json = await response.json()
		const raw = json?.entries ?? {}
		for (const [fileid, entry] of Object.entries(raw)) {
			const kind = (entry as Entry)?.kind === 'library' ? 'library' : 'canvas-template'
			const scope = (entry as Entry)?.scope === 'org' ? 'org' : 'personal'
			map.set(String(fileid), { kind, scope })
		}
	} catch (error) {
		// best-effort; leave the picker untouched on failure
	}
	return map
}

const ID_PREFIX = 'template-picker-'

function fileIdOf(item: Element): string | null {
	const input = item.querySelector('input[type="radio"]') as HTMLInputElement | null
	const id = input?.id
	if (!id) {
		return null
	}
	// e.g. "template-picker-1955" -> "1955", "template-picker--1" -> "-1".
	return id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id
}

function scopeOf(fileid: string | null): Scope {
	if (fileid === '-1') {
		return 'personal'
	}
	return (fileid && entries?.get(fileid)?.scope) || 'personal'
}

function kindOf(fileid: string | null): Kind | null {
	if (fileid === '-1') {
		return null
	}
	return (fileid && entries?.get(fileid)?.kind) || 'canvas-template'
}

// Compact the tiles via INLINE styles — the component sizes previews with
// min/max-height: var(--height) and width: var(--width), which an injected
// stylesheet can't reliably beat. Inline styles win without !important.
function styleTile(item: HTMLElement, kind: Kind | null): void {
	const preview = item.querySelector('.template-picker__preview') as HTMLElement | null
	if (preview) {
		preview.style.width = '100%'
		preview.style.minHeight = '0'
		preview.style.maxHeight = '76px'
		preview.style.height = '76px'
		preview.style.position = 'relative'
		preview.querySelectorAll('.whiteboard-picker__badge').forEach((el) => el.remove())
		if (kind) {
			const badge = document.createElement('span')
			badge.className = 'whiteboard-picker__badge'
			badge.textContent = badgeLabel(kind)
			badge.style.cssText = 'position:absolute;top:4px;right:4px;padding:1px 6px;border-radius:10px;'
				+ 'font-size:.6875rem;font-weight:600;pointer-events:none;'
				+ 'background:var(--color-primary-element-light, #e2e6ff);'
				+ 'color:var(--color-primary-element-light-text, #333)'
			preview.appendChild(badge)
		}
	}
	const image = item.querySelector('.template-picker__image') as HTMLElement | null
	if (image) {
		image.style.width = 'auto'
		image.style.height = 'auto'
		image.style.maxWidth = '48px'
		image.style.maxHeight = '48px'
		image.style.margin = 'auto'
	}
	const title = item.querySelector('.template-picker__title') as HTMLElement | null
	if (title) {
		title.style.fontSize = '0.8125rem'
		title.style.lineHeight = '1.2'
	}
}

function enhance(list: HTMLElement): void {
	const items = Array.from(list.querySelectorAll('.template-picker__item')) as HTMLElement[]
	if (items.length === 0) {
		return
	}

	// Only the whiteboard picker: at least one non-blank tile must be a known
	// whiteboard entry. Otherwise this is some other file type's picker.
	const isWhiteboard = items.some((item) => {
		const id = fileIdOf(item)
		return id !== null && id !== '-1' && !!entries?.has(id)
	})
	if (!isWhiteboard) {
		return
	}

	const grouped: Record<Scope, HTMLElement[]> = { personal: [], org: [] }
	for (const item of items) {
		grouped[scopeOf(fileIdOf(item))].push(item)
	}

	// Compact, left-aligned grid (inline so it beats the component's var-based grid).
	list.style.gridTemplateColumns = 'repeat(auto-fill, 124px)'
	list.style.gridAutoRows = 'auto'
	list.style.gap = '2px 16px'
	list.style.justifyContent = 'start'
	list.style.maxWidth = 'none'
	list.querySelectorAll('.whiteboard-picker__heading').forEach((el) => el.remove())

	for (const scope of ORDER) {
		const tiles = grouped[scope]
		if (tiles.length === 0) {
			continue
		}
		const header = document.createElement('li')
		header.className = 'whiteboard-picker__heading'
		header.textContent = heading(scope)
		header.style.cssText = 'grid-column:1/-1;margin:14px 0 2px;font-weight:600;font-size:.9rem;color:var(--color-text-maxcontrast)'
		list.appendChild(header)
		for (const tile of tiles) {
			styleTile(tile, kindOf(fileIdOf(tile)))
			list.appendChild(tile)
		}
	}

	list.dataset.whiteboardEnhanced = '1'
}

async function tick(): Promise<void> {
	const list = document.querySelector(
		'.templates-picker__list:not([data-whiteboard-enhanced])',
	) as HTMLElement | null
	if (!list || list.querySelectorAll('.template-picker__item').length === 0) {
		return
	}
	if (loadingEntries) {
		return
	}
	// (Re)load the map when it is missing or when the picker shows files saved
	// after the last fetch — otherwise new entries get default kind/scope.
	const ids = Array.from(list.querySelectorAll('.template-picker__item'))
		.map(fileIdOf)
		.filter((id): id is string => id !== null && id !== '-1')
	const negativeCacheFresh = Date.now() - unresolvedAt < UNRESOLVED_RETRY_MS
	const hasUnknown = ids.some((id) => !entries?.has(id) && !(negativeCacheFresh && unresolvedIds.has(id)))
	if (!entries || hasUnknown) {
		loadingEntries = true
		entries = await loadEntries()
		loadingEntries = false
		unresolvedIds.clear()
		for (const id of ids) {
			if (!entries.has(id)) {
				unresolvedIds.add(id)
			}
		}
		unresolvedAt = Date.now()
	}
	try {
		enhance(list)
	} catch (error) {
		// ignore – leave picker flat on failure
	}
}

const intervalId = globalThis.setInterval(() => {
	tick().catch(() => {})
}, 400)
globalThis.addEventListener('pagehide', () => {
	globalThis.clearInterval(intervalId)
})
