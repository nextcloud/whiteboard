/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useState } from 'react'
import { Icon } from '@mdi/react'
import { mdiAccount } from '@mdi/js'
import { generateUrl } from '@nextcloud/router'

interface AvatarProps {
	userId?: string
	displayName: string
	size: number
	className?: string
}

export function Avatar({ userId, displayName, size, className = '' }: AvatarProps) {
	const [error, setError] = useState(false)

	if (!userId || error) {
		return (
			<div
				className={`avatar-fallback ${className}`}
				style={{
					width: size,
					height: size,
					borderRadius: '50%',
					background: 'var(--color-text-maxcontrast)',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
				}}
			>
				<Icon path={mdiAccount} size={size / 48} color="white" />
			</div>
		)
	}

	return (
		<img
			src={generateUrl(`/avatar/${userId}/${size}`)}
			alt={displayName}
			className={className}
			onError={() => setError(true)}
		/>
	)
}
