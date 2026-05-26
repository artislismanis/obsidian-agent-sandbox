import type { ServerResponse, OutgoingHttpHeaders } from "http";

// Must be well under the proxy's OAS_MCP_TIMEOUT_MS (default 15 s) to prevent
// socket inactivity from triggering a proxy timeout during modal waits.
const KEEPALIVE_INTERVAL_MS = 5_000;

/**
 * Intercepts `res.writeHead` to detect when the SDK opens an SSE stream
 * (Content-Type: text/event-stream), then writes `: keepalive\n\n` comments
 * at KEEPALIVE_INTERVAL_MS. SSE comments are ignored by clients but constitute
 * socket activity, preventing the proxy's inactivity timeout from firing during
 * long modal waits. Non-SSE responses are left untouched.
 * Returns a cleanup function that stops the interval and restores writeHead.
 */
export function startSseKeepalive(res: ServerResponse): () => void {
	let timer: ReturnType<typeof setInterval> | undefined;

	const stop = (): void => {
		if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	const origWriteHead = res.writeHead.bind(res) as typeof res.writeHead;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(res as any).writeHead = function (...args: Parameters<typeof res.writeHead>) {
		const result = (
			origWriteHead as (...a: Parameters<typeof res.writeHead>) => ServerResponse
		)(...args);
		// Only start keepalives for SSE responses. Non-SSE JSON responses complete
		// in milliseconds, but the guard prevents accidental corruption if any
		// non-SSE path ever stalls beyond KEEPALIVE_INTERVAL_MS.
		const hdrs = (args[args.length - 1] ?? {}) as OutgoingHttpHeaders;
		const ctHdr = hdrs["Content-Type"] ?? hdrs["content-type"] ?? res.getHeader("content-type");
		const isSse = String(ctHdr ?? "")
			.toLowerCase()
			.startsWith("text/event-stream");
		if (!isSse) return result;
		if (timer === undefined && !res.writableEnded) {
			timer = setInterval(() => {
				if (res.writableEnded || res.destroyed) {
					stop();
					return;
				}
				try {
					res.write(": keepalive\n\n");
				} catch {
					stop();
				}
			}, KEEPALIVE_INTERVAL_MS);
		}
		return result;
	};

	const onDone = (): void => stop();
	res.on("finish", onDone);
	res.on("close", onDone);

	return () => {
		stop();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(res as any).writeHead = origWriteHead;
		res.off("finish", onDone);
		res.off("close", onDone);
	};
}
