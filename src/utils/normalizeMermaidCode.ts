export function normalizeMermaidCode(taskResponse: string): string {
	return taskResponse.trim().replace(
		/^```mermaid[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```$/i,
		'$1',
	)
}
