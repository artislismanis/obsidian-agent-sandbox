import type { PermissionTier } from "./mcp-tools";

const RATE_WINDOW_MS = 60_000;

interface RateBucket {
	timestamps: number[];
}

export class RateLimiter {
	private buckets = new Map<string, RateBucket>();
	private defaultRead: number;
	private defaultWrite: number;

	constructor(defaultRead: number, defaultWrite: number) {
		this.defaultRead = defaultRead;
		this.defaultWrite = defaultWrite;
	}

	check(toolName: string, tier: PermissionTier): boolean {
		const limit = tier === "read" || tier === "navigate" ? this.defaultRead : this.defaultWrite;
		const now = Date.now();
		let bucket = this.buckets.get(toolName);
		if (!bucket) {
			bucket = { timestamps: [] };
			this.buckets.set(toolName, bucket);
		}
		while (bucket.timestamps.length > 0 && now - bucket.timestamps[0] >= RATE_WINDOW_MS) {
			bucket.timestamps.shift();
		}
		if (bucket.timestamps.length >= limit) return false;
		bucket.timestamps.push(now);
		return true;
	}
}
