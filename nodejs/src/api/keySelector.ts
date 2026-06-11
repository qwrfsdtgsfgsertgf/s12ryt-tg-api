/**
 * Multi API-Key Selector with Failover Tracking
 *
 * Storage format in DB: providers.api_key stores JSON array string
 *   e.g. '["sk-xxx1","sk-xxx2","sk-xxx3"]'
 *   Legacy single key: "sk-xxx1" (auto-migrated on startup)
 *
 * Selection strategy:
 *   - Pick first non-suspended key
 *   - Track consecutive failures per (provider_id, key_index)
 *   - After 5 consecutive failures → suspend for 5 minutes
 *   - On success → reset fail count
 */

// ── Configuration ──────────────────────────────────────────────
const MAX_CONSECUTIVE_FAILURES = 5;
const SUSPEND_DURATION_MS = 300_000; // 5 minutes

// ── In-memory state ────────────────────────────────────────────
// { providerId: { keyIndex: { failCount, suspendedUntil } } }
const _state: Map<number, Map<number, { failCount: number; suspendedUntil: number }>> = new Map();

// ── Public API ─────────────────────────────────────────────────

export function parseApiKeys(apiKeyJson: string): string[] {
  /** Parse api_key field into list of keys.
   *  Accepts JSON array string or legacy single string.
   */
  if (!apiKeyJson) return [];
  try {
    const parsed = JSON.parse(apiKeyJson);
    if (Array.isArray(parsed)) {
      return parsed.filter((k): k is string => typeof k === 'string' && Boolean(k.trim())).map(k => k.trim());
    }
  } catch { /* not JSON */ }
  // Legacy single key
  const key = apiKeyJson.trim();
  return key ? [key] : [];
}

export function selectKey(providerId: number, apiKeyJson: string): { key: string | null; keyIndex: number | null } {
  /** Select the best available API key for a provider. */
  const keys = parseApiKeys(apiKeyJson);
  if (!keys.length) return { key: null, keyIndex: null };

  const now = Date.now();
  const providerState = _state.get(providerId) ?? new Map();

  // Try each key in order, skip suspended ones
  for (let idx = 0; idx < keys.length; idx++) {
    const entry = providerState.get(idx);
    const failCount = entry?.failCount ?? 0;
    let suspendedUntil = entry?.suspendedUntil ?? 0;

    // Check if suspension has expired → auto-recover
    if (suspendedUntil > 0 && now >= suspendedUntil) {
      providerState.set(idx, { failCount: 0, suspendedUntil: 0 });
      _state.set(providerId, providerState);
      return { key: keys[idx], keyIndex: idx };
    }

    // Not suspended
    if (suspendedUntil <= 0) {
      return { key: keys[idx], keyIndex: idx };
    }
  }

  // All keys suspended — use the one that recovers soonest
  let soonestIdx = 0;
  let soonestTime = Infinity;
  for (let idx = 0; idx < keys.length; idx++) {
    const entry = providerState.get(idx);
    const suspendedUntil = entry?.suspendedUntil ?? 0;
    if (suspendedUntil < soonestTime) {
      soonestTime = suspendedUntil;
      soonestIdx = idx;
    }
  }

  // Force recover the soonest one
  providerState.set(soonestIdx, { failCount: 0, suspendedUntil: 0 });
  _state.set(providerId, providerState);
  return { key: keys[soonestIdx], keyIndex: soonestIdx };
}

export function reportSuccess(providerId: number, keyIndex: number): void {
  /** Report a successful API call — reset fail count. */
  const providerState = _state.get(providerId);
  if (!providerState) return;
  if (providerState.has(keyIndex)) {
    providerState.set(keyIndex, { failCount: 0, suspendedUntil: 0 });
  }
}

export function reportFailure(providerId: number, keyIndex: number): void {
  /** Report a failed API call — increment fail count, suspend if threshold reached. */
  let providerState = _state.get(providerId);
  if (!providerState) {
    providerState = new Map();
    _state.set(providerId, providerState);
  }

  const entry = providerState.get(keyIndex) ?? { failCount: 0, suspendedUntil: 0 };
  entry.failCount += 1;

  if (entry.failCount >= MAX_CONSECUTIVE_FAILURES) {
    entry.suspendedUntil = Date.now() + SUSPEND_DURATION_MS;
  }

  providerState.set(keyIndex, entry);
}

export interface KeyStatus {
  index: number;
  keyPrefix: string;
  failCount: number;
  isSuspended: boolean;
  suspendedUntil: number | null;
}

export function getKeyStatus(providerId: number, apiKeyJson: string): KeyStatus[] {
  /** Get status of all keys for display purposes. */
  const keys = parseApiKeys(apiKeyJson);
  const now = Date.now();
  const providerState = _state.get(providerId) ?? new Map();

  return keys.map((key, idx) => {
    const entry = providerState.get(idx);
    const failCount = entry?.failCount ?? 0;
    const suspendedUntil = entry?.suspendedUntil ?? 0;
    const isSuspended = suspendedUntil > now;

    return {
      index: idx,
      keyPrefix: key.length > 8 ? key.slice(0, 8) + '...' : key,
      failCount,
      isSuspended,
      suspendedUntil: isSuspended ? suspendedUntil : null,
    };
  });
}

export function getFirstKey(apiKeyJson: string): string {
  /** Get the first API key from JSON string (for model fetching, detection, etc). */
  const keys = parseApiKeys(apiKeyJson);
  return keys[0] ?? '';
}
