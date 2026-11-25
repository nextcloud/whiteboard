/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// A static import keeps the worker a single self-contained bundle like
// syncWorker.ts. The legacy build brings its own polyfills, Promise.try
// among them, as the worker doesn't share the main thread's globals.
import 'pdfjs-dist/legacy/build/pdf.worker.min.mjs'
