/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Removes Markdown code fences from Mermaid diagram responses.
 *
 * @param taskResponse - Raw Mermaid response from the assistant.
 */
export function normalizeMermaidCode(taskResponse: string): string {
	return taskResponse.trim().replace(
		/^```(?:mermaid)?[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```$/i,
		'$1',
	)
}
