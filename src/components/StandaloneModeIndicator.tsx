/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useState, memo, useCallback } from 'react'
import { Icon } from '@mdi/react'
import { mdiAccountNetworkOff } from '@mdi/js'
import { t } from '@nextcloud/l10n'

const TOOLTIP = t(
	'whiteboard',
	'Collaboration is not available — no collaboration server is configured. '
	+ 'Opening this whiteboard in multiple browser tabs or windows at the same time may cause data conflicts.',
)

const StandaloneModeIndicatorComponent = () => {
	const [expanded, setExpanded] = useState(false)

	const toggleExpanded = useCallback(() => setExpanded(prev => !prev), [])

	const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault()
			toggleExpanded()
		}
	}, [toggleExpanded])

	return (
		<div
			className={`standalone-mode-indicator ${expanded ? 'standalone-mode-indicator--expanded' : ''}`}
			onClick={toggleExpanded}
			onKeyDown={handleKeyDown}
			title={TOOLTIP}
			role="button"
			aria-live="polite"
			aria-label={`${t('whiteboard', 'Solo mode')}. ${expanded ? TOOLTIP : t('whiteboard', 'Click to expand.')}`}
			tabIndex={0}
		>
			<div className="standalone-mode-indicator__icon-container">
				<Icon path={mdiAccountNetworkOff} size={0.9} aria-hidden="true" />
			</div>
			{expanded && (
				<div className="standalone-mode-indicator__content">
					<span className="standalone-mode-indicator__text">
						{t('whiteboard', 'Solo mode')}
					</span>
				</div>
			)}
		</div>
	)
}

export const StandaloneModeIndicator = memo(StandaloneModeIndicatorComponent)
StandaloneModeIndicator.displayName = 'StandaloneModeIndicator'
