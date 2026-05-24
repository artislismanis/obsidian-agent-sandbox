import { requestUrl } from "obsidian";

const FETCH_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
	});
	// Swallow the loser's late rejection so it doesn't surface as an
	// unhandled-rejection warning when the timeout wins the race.
	promise.catch(() => undefined);
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Resolve the host part of a ttyd URL.
 *
 * `ttydBindAddress` controls where ttyd listens inside the container; the
 * plugin needs a reachable address to connect back to it.
 *
 * - `127.0.0.1` (default) and `0.0.0.0` both map to literal `127.0.0.1` —
 *   prefer the literal over `localhost` to avoid IPv6 resolution surprises
 *   (`::1` vs `127.0.0.1`) on IPv4-only hosts.
 * - Any other address (e.g. a LAN IP) is used verbatim.
 */
function resolveHost(bindAddress: string | undefined): string {
	const v = (bindAddress ?? "").trim();
	if (!v || v === "127.0.0.1" || v === "0.0.0.0") return "127.0.0.1";
	return v;
}

export async function pollUntilReady(
	port: number,
	maxRetries: number,
	backoff: number | ((attemptIdx: number) => number),
	isAborted: () => boolean,
	onAttempt?: (attemptIdx: number, waitMs: number) => void,
	bindAddress?: string,
): Promise<boolean> {
	const host = resolveHost(bindAddress);
	const url = `http://${host}:${port}`;
	for (let i = 0; i < maxRetries; i++) {
		if (isAborted()) return false;

		try {
			const resp = await withTimeout(
				requestUrl({ url, throw: false }),
				FETCH_TIMEOUT_MS,
				url,
			);
			if (resp.status === 200) {
				return true;
			}
		} catch {
			// Not ready yet
		}

		if (isAborted()) return false;

		// Skip the wait after the final attempt — no next iteration would see it.
		if (i === maxRetries - 1) break;
		const waitMs = typeof backoff === "number" ? backoff : backoff(i);
		onAttempt?.(i, waitMs);
		await new Promise((resolve) => setTimeout(resolve, waitMs));
	}
	return false;
}

/** Exponential backoff: 500 ms × 1.5^n, capped at 5 s. */
export function exponentialBackoff(attemptIdx: number): number {
	return Math.min(5000, Math.round(500 * Math.pow(1.5, attemptIdx)));
}

export function buildWsUrl(port: number, bindAddress?: string): string {
	return `ws://${resolveHost(bindAddress)}:${port}/ws`;
}
