/* eslint-disable */
/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback } from 'react'
import type { ChangeEvent } from 'react'
import { MainMenu } from '@excalidraw/excalidraw'
import { Icon } from '@mdi/react'
import { mdiAccount, mdiAccountGroup, mdiEye, mdiEyeOff } from '@mdi/js'
import { useCreatorDisplayStore } from '../stores/useCreatorDisplayStore'
import type { CreatorDisplaySettings } from '../types/whiteboard'
import styles from './CreatorMenuItem.module.scss'

export const CreatorMenuItem = () => {
	const { settings, setEnabled, setDisplayMode, setOpacity } = useCreatorDisplayStore()

	const handleToggle = useCallback(() => {
		setEnabled(!settings.enabled)
	}, [settings.enabled, setEnabled])

	const handleOpacityChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
		setOpacity(parseFloat(e.target.value))
	}, [setOpacity])

	const handleModeChange = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
		setDisplayMode(e.target.value as CreatorDisplaySettings['displayMode'])
	}, [setDisplayMode])

	return (
		<>
			<MainMenu.Separator />
			<MainMenu.Item
				icon={<Icon path={settings.enabled ? mdiAccountGroup : mdiAccount} size="16px" />}
				onSelect={handleToggle}
			>
				<div className={styles.container}>
					<span>Show element creators</span>
					<Icon path={settings.enabled ? mdiEye : mdiEyeOff} size="14px" />
				</div>
			</MainMenu.Item>
			
			{settings.enabled && (
				<MainMenu.ItemCustom>
					<div className={styles.settingsWrapper}>
						<div className={styles.fieldWrapper}>
							<label className={styles.label}>
								Display Mode
							</label>
							<select
								value={settings.displayMode}
								onChange={handleModeChange}
								className={styles.select}
								onClick={(e) => e.stopPropagation()}
							>
								<option value="hover">On Hover</option>
								<option value="selection">On Selection</option>
								<option value="always">Always Visible</option>
							</select>
						</div>
						
						<div>
							<label className={styles.label}>
								Opacity: {Math.round(settings.opacity * 100)}%
							</label>
							<input
								type="range"
								min="0.3"
								max="1"
								step="0.1"
								value={settings.opacity}
								onChange={handleOpacityChange}
								className={styles.rangeInput}
								onClick={(e) => e.stopPropagation()}
							/>
						</div>
					</div>
				</MainMenu.ItemCustom>
			)}
		</>
	)
}