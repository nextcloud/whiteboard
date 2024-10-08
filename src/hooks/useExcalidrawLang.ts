/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useState, useEffect } from 'react'
import { getLanguage } from '@nextcloud/l10n'
import { languages } from '@excalidraw/excalidraw'

const languageMap = new Map(languages.map(lang => [lang.code.toLowerCase(), lang.code]))

function mapNextcloudToExcalidrawLang(nextcloudLang: string): string {
	const lowerNextcloudLang = nextcloudLang.toLowerCase()

	if (languageMap.has(lowerNextcloudLang)) {
		return languageMap.get(lowerNextcloudLang)!
	}

	const hyphenatedLang = lowerNextcloudLang.replace('_', '-')
	if (languageMap.has(hyphenatedLang)) {
		return languageMap.get(hyphenatedLang)!
	}

	for (const [excalidrawLang, originalCode] of languageMap) {
		if (excalidrawLang.startsWith(lowerNextcloudLang)
			|| lowerNextcloudLang.startsWith(excalidrawLang.split('-')[0])) {
			return originalCode
		}
	}

	return 'en'
}

export function useExcalidrawLang() {
	const [lang, setLang] = useState(() => mapNextcloudToExcalidrawLang(getLanguage()))

	useEffect(() => {
		const nextcloudLang = getLanguage()
		setLang(mapNextcloudToExcalidrawLang(nextcloudLang))
	}, [])

	return lang
}
