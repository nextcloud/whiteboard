/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useEffect, useState, memo, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Icon } from '@mdi/react'
import { mdiAlert, mdiClose, mdiInformation, mdiCog } from '@mdi/js'
import { generateUrl } from '@nextcloud/router'
import { useCollaborationStore } from '../stores/useCollaborationStore'
import type { AuthErrorType } from '../stores/useCollaborationStore'

interface AuthErrorConfig {
	icon: string
	title: string
	message: string
	actionText?: string
	severity: 'error' | 'warning' | 'info'
}

const getAuthErrorConfig = (errorType: AuthErrorType, isPersistent: boolean): AuthErrorConfig | null => {
	switch (errorType) {
	case 'jwt_secret_mismatch':
		return {
			icon: mdiAlert,
			title: isPersistent ? 'Authentication Configuration Issue' : 'Authentication Error',
			message: isPersistent
				? 'Unable to connect to collaboration server. The JWT secret may be misconfigured. You can continue working locally, and your changes will be saved to your device.'
				: 'Temporary authentication issue. Retrying connection...',
			actionText: isPersistent ? 'Open Admin Settings' : undefined,
			severity: isPersistent ? 'error' : 'warning',
		}
	case 'token_expired':
		return {
			icon: mdiInformation,
			title: 'Session Expired',
			message: 'Your session has expired. Attempting to refresh authentication...',
			severity: 'info',
		}
	case 'unauthorized':
		return {
			icon: mdiAlert,
			title: isPersistent ? 'Access Denied' : 'Authentication Issue',
			message: isPersistent
				? 'You do not have permission to access this whiteboard for collaboration. You can continue working locally.'
				: 'Authentication issue detected. Retrying...',
			severity: isPersistent ? 'error' : 'warning',
		}
	default:
		return null
	}
}

const AuthErrorNotificationComponent = () => {
	const { authError, clearAuthError } = useCollaborationStore(
		useShallow(state => ({
			authError: state.authError,
			clearAuthError: state.clearAuthError,
		})),
	)

	const [isVisible, setIsVisible] = useState(false)
	const [isDismissed, setIsDismissed] = useState(false)

	// Show notification when there's a persistent auth error or multiple failures
	useEffect(() => {
		const shouldShow = authError
			&& authError.type !== null
			&& (authError.isPersistent || authError.consecutiveFailures >= 2)
			&& !isDismissed

		setIsVisible(shouldShow)
	}, [authError, isDismissed])

	// Auto-hide non-persistent errors after some time
	useEffect(() => {
		if (isVisible && !authError.isPersistent) {
			const timer = setTimeout(() => {
				setIsVisible(false)
			}, 8000) // Hide after 8 seconds for non-persistent errors

			return () => clearTimeout(timer)
		}
	}, [isVisible, authError.isPersistent])

	const handleDismiss = useCallback(() => {
		setIsDismissed(true)
		setIsVisible(false)

		// Clear the error from store if it's not persistent
		if (authError && !authError.isPersistent) {
			clearAuthError()
		}
	}, [authError, clearAuthError])

	const handleAction = useCallback(() => {
		// For JWT secret mismatch, open admin settings in a new tab
		if (authError?.type === 'jwt_secret_mismatch' && authError.isPersistent) {
			const adminUrl = generateUrl('/settings/admin/whiteboard')
			window.open(adminUrl, '_blank', 'noopener,noreferrer')
		}
		// Don't dismiss the notification automatically - let user dismiss it manually
	}, [authError])

	if (!isVisible || !authError.type) {
		return null
	}

	const config = getAuthErrorConfig(authError.type, authError.isPersistent)
	if (!config) {
		return null
	}

	return (
		<div className={`auth-error-notification auth-error-notification--${config.severity}`}>
			<div className="auth-error-notification__content">
				<div className="auth-error-notification__icon">
					<Icon path={config.icon} size={1.2} />
				</div>
				<div className="auth-error-notification__text">
					<div className="auth-error-notification__title">
						{config.title}
					</div>
					<div className="auth-error-notification__message">
						{config.message}
					</div>
					{authError.isPersistent && (
						<div className="auth-error-notification__details">
							<small>
								Local changes are automatically saved to your device.
								Collaboration features will be unavailable until this issue is resolved.
							</small>
						</div>
					)}
				</div>
				<div className="auth-error-notification__actions">
					{config.actionText && (
						<button
							className="auth-error-notification__action-button"
							onClick={handleAction}
							title={config.actionText}
						>
							<Icon path={mdiCog} size={0.9} />
						</button>
					)}
					<button
						className="auth-error-notification__close-button"
						onClick={handleDismiss}
						title="Dismiss"
					>
						<Icon path={mdiClose} size={0.9} />
					</button>
				</div>
			</div>
		</div>
	)
}

export const AuthErrorNotification = memo(AuthErrorNotificationComponent)
