/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Side-effect module, so pdfWorkerEntry.ts can order the polyfill ahead of
// pdf.js with a plain static import.
import { applyPromiseTryPolyfill } from './promiseTryPolyfill.ts'

applyPromiseTryPolyfill()
