/**
 * Parse a prompt-template .md file into `[label, body]`. The first non-empty
 * line before a `---` separator is the label; the rest is the prompt body.
 * With no separator, the first non-empty line is the label and the whole
 * file is the body.
 */
export function parsePromptTemplate(content: string, fallbackName: string): [string, string] {
	const sep = /^---\s*$/m.exec(content);
	if (sep) {
		const before = content.slice(0, sep.index).trim();
		const after = content.slice(sep.index + sep[0].length).trim();
		const label =
			before
				.split("\n")
				.find((l) => l.trim())
				?.trim() ?? fallbackName;
		return [label, after];
	}
	const firstLine = content.split("\n").find((l) => l.trim()) ?? fallbackName;
	return [firstLine.trim(), content.trim()];
}

/** Substitute `{{file}}` with the vault path (matches whitespace variants). */
export function substituteFilePlaceholder(body: string, vaultPath: string): string {
	return body.replace(/\{\{\s*file\s*\}\}/g, vaultPath);
}
