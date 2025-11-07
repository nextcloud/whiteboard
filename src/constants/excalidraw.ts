/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ExcalidrawInitialDataState } from '@nextcloud/excalidraw/types/types'

export const initialDataState: ExcalidrawInitialDataState = {
	elements: [],
	appState: {
		currentItemFontFamily: 3,
		currentItemStrokeWidth: 1,
		currentItemRoughness: 0,
	},
	files: {},
}
