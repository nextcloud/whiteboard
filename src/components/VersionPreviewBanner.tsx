/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FC } from 'react'
import { t } from '@nextcloud/l10n'

interface VersionPreviewBannerProps {
	versionLabel: string | null
	sourceLabel: string | null
	onExit: () => void
	onRestore: () => void
	isRestoring: boolean
}

export const VersionPreviewBanner: FC<VersionPreviewBannerProps> = ({
	versionLabel,
	sourceLabel,
	onExit,
	onRestore,
	isRestoring,
}) => {
	const subtitleParts = [versionLabel, sourceLabel].filter(Boolean)

	return (
		<div className="version-preview-banner">
			<div className="version-preview-banner__content">
				<div className="version-preview-banner__title">
					{t('whiteboard', 'Viewing a previous version')}
				</div>
				{subtitleParts.length > 0 && (
					<div className="version-preview-banner__subtitle">
						{subtitleParts.join(' - ')}
					</div>
				)}
				<div className="version-preview-banner__description">
					{t('whiteboard', 'This snapshot is read only. Restore it to make it the latest version, or jump back to the live board.')}
				</div>
			</div>
			<div className="version-preview-banner__actions">
				<button
					type="button"
					className="version-preview-banner__button version-preview-banner__button--secondary"
					onClick={onExit}
				>
					{t('whiteboard', 'Back to latest version')}
				</button>
				<button
					type="button"
					className="version-preview-banner__button version-preview-banner__button--primary"
					onClick={onRestore}
					disabled={isRestoring}
					aria-busy={isRestoring}
				>
					{isRestoring
						? t('whiteboard', 'Restoring…')
						: t('whiteboard', 'Restore this version')}
				</button>
			</div>
		</div>
	)
}

export default VersionPreviewBanner
