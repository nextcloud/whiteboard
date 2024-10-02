/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useState, useEffect } from 'react'
import { getLanguage } from '@nextcloud/l10n'
import { languages } from '@excalidraw/excalidraw'

function mapNextcloudToExcalidrawLang(nextcloudLang: string): string {
	const lowerNextcloudLang = nextcloudLang.toLowerCase()

	const exactMatch = languages.find(
		(lang) =>
			lang.code.toLowerCase() === lowerNextcloudLang
			|| lang.code.toLowerCase().replace('-', '_') === lowerNextcloudLang,
	)
	if (exactMatch) return exactMatch.code

	const partialMatch = languages.find((lang) =>
		lang.code.toLowerCase().startsWith(lowerNextcloudLang.slice(0, 1)),
	)

	if (partialMatch) return partialMatch.code

	return 'en'
}

export function useExcalidrawLang() {
	const [lang, setLang] = useState(
		mapNextcloudToExcalidrawLang(getLanguage()),
	)

	useEffect(() => {
		const nextcloudLang = getLanguage()
		setLang(mapNextcloudToExcalidrawLang(nextcloudLang))
	}, [])

	return lang
}
