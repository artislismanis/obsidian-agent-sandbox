import type { App } from "obsidian";
import { logger } from "./logger";

export interface AuditEntry {
	timestamp: number;
	tool: string;
	success: boolean;
	durationMs: number;
}

export class AuditLog {
	private entries: AuditEntry[] = [];
	private maxEntries: number;
	private sink: ((entry: AuditEntry) => void | Promise<void>) | null = null;
	// Serialise sink invocations so file-rotation (stat → remove → rename →
	// append) can't interleave with concurrent record() calls. Two
	// simultaneous tool invocations near the rotation threshold would race
	// inside createFileAuditSink - both reading the pre-rotation byte count,
	// both deciding to rotate, the second rename clobbering the first archive.
	private sinkChain: Promise<void> = Promise.resolve();

	constructor(maxEntries: number) {
		this.maxEntries = maxEntries;
	}

	setSink(sink: ((entry: AuditEntry) => void | Promise<void>) | null): void {
		this.sink = sink;
	}

	record(entry: AuditEntry): void {
		this.entries.push(entry);
		if (this.entries.length > this.maxEntries) {
			this.entries = this.entries.slice(-this.maxEntries);
		}
		const sink = this.sink;
		if (!sink) return;
		// Serialise writes via a per-sink promise chain so rotation (stat →
		// remove → rename → append) can't interleave with another record().
		// Swallow rejections at every step so a poisoned link can't break the
		// chain and sink failures never propagate into tool execution:
		// - `.catch(() => {})` neutralises any prior-link rejection before
		//   the next sink call - otherwise `then`'s onFulfilled is skipped
		//   and the recursive rejection loops forever.
		// - Inner try/catch + `.catch` handles both sync throws and async
		//   rejections from this iteration's sink call.
		this.sinkChain = this.sinkChain
			.catch(() => {})
			.then(() => {
				try {
					const maybe = sink(entry);
					return maybe instanceof Promise
						? maybe.catch((e) => logger.debug("MCP", "Audit sink failed", e))
						: undefined;
				} catch (e) {
					logger.debug("MCP", "Audit sink failed", e);
				}
			});
	}

	getEntries(): readonly AuditEntry[] {
		return this.entries;
	}
}

const AUDIT_FILE = ".oas/mcp-audit.jsonl";
const AUDIT_FILE_MAX_BYTES = 1_024_000;
const AUDIT_FILE_ARCHIVE = ".oas/mcp-audit.1.jsonl";

// Rate-limited warn helper: a persistent audit failure (disk full, permission
// denied) reports once per minute instead of flooding the console on every
// tool call. The audit log is a security feature; sink failure must surface
// at warn level - debug-level logs are hidden behind the default `info`
// minimum and operators only see them after flipping log levels.
let lastAuditWarnAt = 0;
function warnAuditFailureRateLimited(err: unknown): void {
	const now = Date.now();
	if (now - lastAuditWarnAt < 60_000) return;
	lastAuditWarnAt = now;
	logger.warn("MCP", "Audit append failed (rate-limited; further failures suppressed)", err);
}

export function createFileAuditSink(app: App): (entry: AuditEntry) => Promise<void> {
	const adapter = app.vault.adapter;
	let ensuredDir = false;
	// Track running byte count to stat (and rotate) only when the threshold
	// is suspected - otherwise the sink does 3 vault-adapter calls per tool
	// invocation.
	let estimatedBytes = -1;
	return async (entry) => {
		if (!ensuredDir) {
			try {
				await adapter.mkdir(".oas");
				ensuredDir = true;
			} catch (err) {
				// Directory-already-exists is fine - confirm via stat.
				const stat = await adapter.stat(".oas").catch(() => null);
				if (stat?.type === "folder") {
					ensuredDir = true;
				} else {
					// Real failure (permissions, etc.) - leave ensuredDir false
					// so the next call retries instead of dropping appends.
					throw err;
				}
			}
		}
		try {
			const line = JSON.stringify(entry) + "\n";
			if (estimatedBytes < 0) {
				const stat = await adapter.stat(AUDIT_FILE).catch(() => null);
				estimatedBytes = stat?.size ?? 0;
			}
			if (estimatedBytes > AUDIT_FILE_MAX_BYTES) {
				try {
					await adapter.remove(AUDIT_FILE_ARCHIVE).catch(() => undefined);
					await adapter.rename(AUDIT_FILE, AUDIT_FILE_ARCHIVE);
					// Rotation succeeded: live file is empty, so reset to 0
					// rather than -1 (sentinel for re-stat).
					estimatedBytes = 0;
				} catch {
					// Rename failed - re-stat next iteration to pick up the real
					// size (the cap-check will retry rotation then).
					estimatedBytes = -1;
				}
			}
			await adapter.append(AUDIT_FILE, line);
			// Only accumulate when the counter holds a real value. If the
			// re-stat sentinel (-1) is active (rotation failed last round),
			// `+=N` would raise it positive, the next `< 0` check would skip
			// the re-stat, and the file would grow unbounded.
			if (estimatedBytes >= 0) estimatedBytes += Buffer.byteLength(line);
		} catch (e) {
			// Warn-level so disk-full / permission-denied surfaces at the
			// default log threshold - the audit log is a security feature.
			// Rate-limited to one entry per minute. Never re-throw - audit
			// writes must not block tool execution.
			warnAuditFailureRateLimited(e);
		}
	};
}
