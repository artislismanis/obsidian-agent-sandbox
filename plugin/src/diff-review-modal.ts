import { Modal } from "obsidian";
import type { App } from "obsidian";

export interface ReviewRequest {
	operation: string;
	filePath: string;
	oldContent?: string;
	newContent?: string;
	description: string;
}

export interface ReviewResult {
	approved: boolean;
}

export function computeUnifiedDiff(oldText: string, newText: string): string {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const output: string[] = [];
	let i = 0;
	let j = 0;

	while (i < oldLines.length || j < newLines.length) {
		if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
			output.push(`  ${oldLines[i]}`);
			i++;
			j++;
		} else {
			let foundMatch = false;
			for (let ahead = 1; ahead <= 3; ahead++) {
				if (j + ahead < newLines.length && oldLines[i] === newLines[j + ahead]) {
					for (let k = 0; k < ahead; k++) output.push(`+ ${newLines[j + k]}`);
					j += ahead;
					foundMatch = true;
					break;
				}
				if (i + ahead < oldLines.length && oldLines[i + ahead] === newLines[j]) {
					for (let k = 0; k < ahead; k++) output.push(`- ${oldLines[i + k]}`);
					i += ahead;
					foundMatch = true;
					break;
				}
			}
			if (!foundMatch) {
				if (i < oldLines.length) {
					output.push(`- ${oldLines[i]}`);
					i++;
				}
				if (j < newLines.length) {
					output.push(`+ ${newLines[j]}`);
					j++;
				}
			}
		}
	}

	return output.join("\n");
}

export class DiffReviewModal extends Modal {
	private resolve: ((result: ReviewResult) => void) | null = null;
	private request: ReviewRequest;

	constructor(app: App, request: ReviewRequest) {
		super(app);
		this.request = request;
	}

	review(): Promise<ReviewResult> {
		return new Promise<ReviewResult>((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText(`Review: ${this.request.operation}`);

		contentEl.createEl("p", {
			text: this.request.description,
			cls: "diff-review-description",
		});

		contentEl.createEl("div", { cls: "diff-review-path", text: this.request.filePath });

		if (this.request.oldContent !== undefined || this.request.newContent !== undefined) {
			const diffEl = contentEl.createEl("pre", { cls: "diff-review-diff" });
			diffEl.style.maxHeight = "400px";
			diffEl.style.overflow = "auto";
			diffEl.style.fontSize = "12px";
			diffEl.style.fontFamily = "var(--font-monospace)";
			diffEl.style.padding = "8px";
			diffEl.style.borderRadius = "4px";
			diffEl.style.backgroundColor = "var(--background-secondary)";

			const diff = computeUnifiedDiff(
				this.request.oldContent ?? "",
				this.request.newContent ?? "",
			);
			for (const line of diff.split("\n")) {
				const lineEl = diffEl.createEl("div");
				lineEl.textContent = line;
				if (line.startsWith("+ ")) {
					lineEl.style.color = "var(--text-success)";
				} else if (line.startsWith("- ")) {
					lineEl.style.color = "var(--text-error)";
				}
			}
		}

		contentEl.createDiv({ cls: "modal-button-container" }, (div) => {
			div.createEl("button", { text: "Reject", cls: "mod-muted" }, (btn) => {
				btn.addEventListener("click", () => {
					this.resolve?.({ approved: false });
					this.close();
				});
			});
			div.createEl("button", { text: "Approve", cls: "mod-cta" }, (btn) => {
				btn.addEventListener("click", () => {
					this.resolve?.({ approved: true });
					this.close();
				});
			});
		});
	}

	onClose(): void {
		if (this.resolve) {
			this.resolve({ approved: false });
			this.resolve = null;
		}
		this.contentEl.empty();
	}
}
