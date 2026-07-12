/**
 * In-memory cache for the global provider User-Agent setting.
 *
 * Extracted into its own module to avoid a circular dependency:
 * server.ts imports routes.ts (to mount the web router), so routes.ts
 * cannot import back from server.ts to invalidate the cache.
 *
 * State machine:
 *   - not loaded (loaded=false, value=null): cache cold, needs DB read
 *   - loading   (loaded=true,  value=null): DB read in flight
 *   - loaded    (loaded=true,  value=...):  ready
 */
let cache: string | null = null;
let loaded = false;

export function getUserAgentCache(): string | null {
  return cache;
}

export function isUserAgentLoaded(): boolean {
  return loaded;
}

/** Mark the cache as loaded without changing the value (used during load). */
export function markUserAgentLoading(): void {
  loaded = true;
}

/** Set the cached value and mark as loaded. */
export function setUserAgentCache(value: string | null): void {
  cache = value;
  loaded = true;
}

/** Clear the cache so the next access re-reads from DB. */
export function invalidateUserAgentCache(): void {
  cache = null;
  loaded = false;
}
