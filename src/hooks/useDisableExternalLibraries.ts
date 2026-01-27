/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useEffect } from 'react'
import { loadState } from '@nextcloud/initial-state'
import { translate as t } from '@nextcloud/l10n'

export function useDisableExternalLibraries() {
	useEffect(() => {
		const disableExternalLibraries = loadState('whiteboard', 'disableExternalLibraries')

		if (!disableExternalLibraries) return

		const translatedHint = t('whiteboard', 'Select an item on canvas to add it here, or add a local library below.')
		const translatedButton = t('whiteboard', 'Add local library')

		const style = document.createElement('style')
		style.textContent = `
    .excalidraw .library-menu-browse-button,
    .excalidraw .library-menu-control-buttons--at-bottom,
    .excalidraw .library-menu-items-container__header--excal,
    .excalidraw .library-menu-items-container__header--excal + * {
     display: none !important;
    }
    
    .excalidraw .library-menu-items__no-items__hint {
     font-size: 0;
    }
    
    .excalidraw .library-menu-items__no-items__hint::after {
     content: "${translatedHint.replace(/"/g, '\\"')}";
     font-size: 0.875rem;
     display: block;
    }
    
    .excalidraw .library-menu-dropdown-container:not(.library-menu-dropdown-container--in-heading) {
     width: 100% !important;
    }
    
    .excalidraw .library-menu-dropdown-container:not(.library-menu-dropdown-container--in-heading) .dropdown-menu-button {
     width: 100% !important;
     background-color: var(--color-primary) !important;
     font-size: 0.75rem;
     color: #fff;
    }
    
    .excalidraw .library-menu-dropdown-container:not(.library-menu-dropdown-container--in-heading) .dropdown-menu-button:hover {
     background-color: var(--color-brand-hover) !important;
    }
    
    .excalidraw .library-menu-dropdown-container:not(.library-menu-dropdown-container--in-heading) .dropdown-menu-button svg {
     display: none !important;
    }
    
    .excalidraw .library-menu-dropdown-container:not(.library-menu-dropdown-container--in-heading) .dropdown-menu-button::after {
     content: "${translatedButton.replace(/"/g, '\\"')}";
    }
   `
		document.head.appendChild(style)

		return () => document.head.removeChild(style)
	}, [])
}
