/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useEffect, useState, memo, useCallback, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Icon } from '@mdi/react'
import { mdiWifiOff, mdiWifi, mdiWifiStrength1, mdiWifiStrength2, mdiLoading } from '@mdi/js'
// Import the correct store
import { useCollaborationStore } from '../stores/useCollaborationStore'
import type { CollaborationConnectionStatus } from '../stores/useCollaborationStore'

interface StatusConfig {
	icon: string;
	text: string;
	className: string;
	description: string;
}

// Update function to accept CollaborationConnectionStatus
const getStatusConfig = (status: CollaborationConnectionStatus): StatusConfig => {
	switch (status) {
	case 'offline':
		return {
			icon: mdiWifiOff,
			text: 'Offline',
			className: 'network-status--offline',
			description: 'Offline - Changes saved locally.',
		}
	case 'connecting':
		return {
			icon: mdiWifiStrength1, // Or mdiLoading directly?
			text: 'Connecting',
			className: 'network-status--connecting',
			description: 'Connecting to collaboration server...',
		}
	case 'reconnecting':
		return {
			icon: mdiWifiStrength2, // Or mdiLoading directly?
			text: 'Reconnecting',
			className: 'network-status--reconnecting',
			description: 'Attempting to reconnect...',
		}
	case 'online':
		return {
			icon: mdiWifi,
			text: 'Online',
			className: 'network-status--online',
			description: 'Connected.',
		}
	default:
		// Fallback for safety, though should not happen with TypeScript
		console.warn(`[NetworkStatusIndicator] Unknown status: ${status}`)
		return {
			icon: mdiWifiOff,
			text: 'Unknown',
			className: 'network-status--offline',
			description: 'Unknown connection status.',
		}
	}
}

const NetworkStatusIndicatorComponent = () => {
	// Use state from useCollaborationStore with useShallow to prevent unnecessary re-renders
	const { status, lastConnected, reconnectAttempts } = useCollaborationStore(
		useShallow(state => ({
			status: state.status,
			lastConnected: state.lastConnected,
			reconnectAttempts: state.reconnectAttempts,
		})),
	)
	const [expanded, setExpanded] = useState(false)
	const [visible] = useState(true) // Assume visible initially

	// Refs to track previous status to avoid unnecessary effects
	const prevStatusRef = useRef(status)

	// Auto-collapse after showing status change, expand briefly on change
	useEffect(() => {
		// Only trigger the effect if status actually changed
		if (prevStatusRef.current !== status) {
			prevStatusRef.current = status
			setExpanded(true) // Expand briefly on status change
			const timeout = setTimeout(() => {
				setExpanded(false)
			}, 3000) // Auto-collapse after 3 seconds

			return () => clearTimeout(timeout)
		}
	}, [status]) // Run only when status changes

	// Memoize status config to prevent recalculation on every render
	const statusConfig = useMemo(() => getStatusConfig(status), [status])
	const { icon, text, className, description } = statusConfig

	// Enhanced description with more details
	const enhancedDescription = useMemo(() => {
		let desc = description
		if (status === 'offline' || status === 'reconnecting') {
			if (lastConnected) {
				const timeAgo = Math.round((Date.now() - lastConnected) / 1000)
				if (timeAgo < 60) desc += ` Last connected ${timeAgo}s ago.`
				else if (timeAgo < 3600) desc += ` Last connected ${Math.floor(timeAgo / 60)}m ago.`
				else desc += ` Last connected ${Math.floor(timeAgo / 3600)}h ago.`
			}
			if (status === 'reconnecting' && reconnectAttempts > 0) {
				desc += ` Attempt ${reconnectAttempts}.`
			}
		}
		return desc
	}, [status, description, lastConnected, reconnectAttempts])

	const toggleExpanded = useCallback(() => {
		setExpanded(prev => !prev)
	}, [])

	const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault()
			toggleExpanded()
		}
	}, [toggleExpanded])

	if (!visible) return null // Render nothing if not visible (though currently always true)

	return (
		<div
			className={`network-status ${className} ${expanded ? 'network-status--expanded' : ''}`}
			onClick={toggleExpanded}
			onKeyDown={handleKeyDown}
			title={enhancedDescription} // Tooltip shows detailed info
			role="button" // More appropriate role than status if clickable
			aria-live="polite" // Announce changes politely
			aria-label={`Connection: ${text}. ${expanded ? enhancedDescription : 'Click to expand.'}`} // Dynamic label
			tabIndex={0} // Make focusable
		>
			<div className="network-status__icon-container">
				{/* Show loading spinner overlaid when connecting/reconnecting */}
				{(status === 'connecting' || status === 'reconnecting')
					? <Icon path={mdiLoading} size={0.9} spin={1} aria-hidden="true" />
					: <Icon path={icon} size={0.9} aria-hidden="true" />}
			</div>
			{/* Show text only when expanded */}
			{expanded && (
				<div className="network-status__content">
					<span className="network-status__text">{text}</span>
				</div>
			)}
		</div>
	)
}

export const NetworkStatusIndicator = memo(NetworkStatusIndicatorComponent)
NetworkStatusIndicator.displayName = 'NetworkStatusIndicator'
