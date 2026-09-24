/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Static imports only: this keeps the worker a single self-contained bundle
// like syncWorker.ts, and sibling imports evaluate in order, so the polyfill
// is in place before pdf.js's own top-level code runs.
import '../utils/applyPromiseTryPolyfillOnImport.ts'
import 'pdfjs-dist/legacy/build/pdf.worker.min.mjs'
