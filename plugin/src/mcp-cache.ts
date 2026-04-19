import type { MetadataCache } from "obsidian";

export class VaultCache {
	private cache = new Map<string, unknown>();
	private metadataCache: MetadataCache;
	private unregister: (() => void)[] = [];

	constructor(metadataCache: MetadataCache) {
		this.metadataCache = metadataCache;

		// Link graph is rebuilt from resolvedLinks — invalidate only when
		// Obsidian finishes resolving links, not on every frontmatter edit.
		const onResolved = () => this.invalidate("graph");
		this.metadataCache.on("resolved", onResolved);
		this.unregister.push(() => this.metadataCache.off("resolved", onResolved));
	}

	get<T>(key: string, computeFn: () => T): T {
		if (this.cache.has(key)) return this.cache.get(key) as T;
		const value = computeFn();
		this.cache.set(key, value);
		return value;
	}

	invalidate(key: string): void {
		this.cache.delete(key);
	}

	invalidateAll(): void {
		this.cache.clear();
	}

	destroy(): void {
		for (const fn of this.unregister) fn();
		this.unregister = [];
		this.cache.clear();
	}
}
