/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useEffect, useState, memo } from 'react'
import { Icon } from '@mdi/react'
import { mdiWifiOff, mdiWifi, mdiWifiStrength1, mdiLoading } from '@mdi/js'
import { useNetworkStore } from '../stores/useNetworkStore'
import type { ConnectionStatus } from '../stores/useNetworkStore'

interface StatusConfig {
	icon: string;
	text: string;
	className: string;
}

// Memoize getStatusConfig outside component to prevent recomputation
const getStatusConfig = (status: ConnectionStatus): StatusConfig => {
	switch (status) {
	case 'offline':
		return {
			icon: mdiWifiOff,
			text: 'Offline',
			className: 'network-status--offline',
		}
	case 'connecting':
		return {
			icon: mdiWifiStrength1,
			text: 'Connecting',
			className: 'network-status--connecting',
		}
	case 'online':
		return {
			icon: mdiWifi,
			text: 'Online',
			className: 'network-status--online',
		}
	}
}

export const NetworkStatusIndicator = memo(() => {
	const { status } = useNetworkStore()
	const [expanded, setExpanded] = useState(false)
	const [visible, setVisible] = useState(false)

	// Delay appearance of network status indicator
	useEffect(() => {
		const timer = setTimeout(() => {
			setVisible(true)
		}, 500)
		return () => clearTimeout(timer)
	}, [])

	// Auto-collapse after showing status change
	useEffect(() => {
		// Always show status change briefly
		setExpanded(true)

		const timeout = setTimeout(() => {
			setExpanded(false)
		}, 3000)

		return () => clearTimeout(timeout)
	}, [status])

	const { icon, text, className } = getStatusConfig(status)

	const toggleExpanded = () => {
		setExpanded(!expanded)
	}

	// Don't render until visible
	if (!visible) return null

	return (
		<div
			className={`network-status ${className} ${expanded ? 'network-status--expanded' : ''}`}
			onClick={toggleExpanded}
			title={status === 'offline'
				? 'Offline - Changes will be saved locally'
				: status === 'connecting' ? 'Connecting to server...' : 'Connected to server'}
		>
			<div className="network-status__icon-container">
				<Icon path={icon} size={0.7} />
				{status === 'connecting' && (
					<div className="network-status__loading-spinner">
						<Icon path={mdiLoading} size={0.7} spin={1} />
					</div>
				)}
			</div>
			<div className="network-status__content">
				<span className="network-status__text">{text}</span>
			</div>
		</div>
	)
})
