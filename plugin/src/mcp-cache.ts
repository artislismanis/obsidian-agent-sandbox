import type { EventRef, MetadataCache } from "obsidian";

// Cap unique cache keys so a misbehaving agent calling `vault_properties` with
// hundreds of distinct property names between metadata-resolve events doesn't
// grow the Map unboundedly. Each entry holds a sorted (value, count) array
// proportional to vault content; this bounds the map's key count.
const MAX_CACHE_ENTRIES = 64;

export class VaultCache {
	private cache = new Map<string, unknown>();
	private metadataCache: MetadataCache;
	private eventRefs: EventRef[] = [];

	constructor(metadataCache: MetadataCache) {
		this.metadataCache = metadataCache;

		// All cached values (graph, tag counts, property names) derive from
		// metadataCache. "resolved" fires after a batch of metadata updates,
		// so wholesale invalidation is correct and avoids per-key bookkeeping.
		// EventRef + offref (Obsidian's recommended pattern) pairs by ref
		// identity rather than callback identity, so it survives any internal
		// wrapping the API does on its handlers.
		this.eventRefs.push(this.metadataCache.on("resolved", () => this.invalidateAll()));
	}

	get<T>(key: string, computeFn: () => T): T {
		if (this.cache.has(key)) {
			// LRU touch: delete-then-set so frequently-accessed keys move to
			// the tail in insertion order. When over cap, drop the head.
			const v = this.cache.get(key) as T;
			this.cache.delete(key);
			this.cache.set(key, v);
			return v;
		}
		const value = computeFn();
		if (this.cache.size >= MAX_CACHE_ENTRIES) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) this.cache.delete(oldest);
		}
		this.cache.set(key, value);
		return value;
	}

	invalidateAll(): void {
		this.cache.clear();
	}

	destroy(): void {
		for (const ref of this.eventRefs) this.metadataCache.offref(ref);
		this.eventRefs = [];
		this.cache.clear();
	}
}
