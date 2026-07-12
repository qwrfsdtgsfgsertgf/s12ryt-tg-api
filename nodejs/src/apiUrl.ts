/**
 * Effective API URL resolver.
 *
 * Combines three sources into a single priority chain:
 *   1. DB `settings.api_url` — manually set by admin via /sub_url or Web Console
 *   2. Cloudflare Tunnel URL — auto-assigned when `CLOUDFLARE_TUNNEL=quick`
 *   3. `config.DEFAULT_API_URL` — environment variable fallback
 *
 * Admin's explicit manual override always wins. Tunnel URL is only used when
 * the admin hasn't set a custom value, so enabling/disabling a tunnel won't
 * clobber a deliberate configuration.
 *
 * Empty / whitespace-only strings are treated as "not set" so that a botched
 * PUT never strands the service on an empty URL.
 */

import { config } from "./config.js";
import { getSetting } from "./db/database.js";
import { getTunnelUrl } from "./tunnel.js";

/**
 * Read the raw `settings.api_url` value, normalising empty/whitespace strings
 * to null. This is the value the admin actually configured (or null if they
 * cleared it), before any tunnel/default fallback is applied.
 */
export async function getRawConfiguredApiUrl(): Promise<string | null> {
  const raw = await getSetting("api_url");
  return raw && raw.trim() ? raw.trim() : null;
}

/**
 * Resolve the API URL that should be shown to users / used for Web Console
 * login links, considering manual override, tunnel URL and env fallback.
 *
 * Precedence: configured api_url > tunnel url > DEFAULT_API_URL.
 * Whitespace-only configured values are ignored (treated as "not set").
 */
export async function getEffectiveApiUrl(): Promise<string> {
  return (await getRawConfiguredApiUrl()) ?? getTunnelUrl() ?? config.DEFAULT_API_URL;
}

/**
 * The source the effective URL currently comes from. Used by callers to add
 * contextual warnings (e.g. "/url" warns that a quick-tunnel URL is temporary).
 *
 * - `"configured"` — admin set it via /sub_url or settings; sticky across restarts
 * - `"tunnel"`     — Cloudflare quick-tunnel URL; changes on every restart
 * - `"tunnel-pending"` — tunnel mode active but URL not received yet (race window)
 * - `"default"`    — DEFAULT_API_URL fallback (typically http://localhost:8000)
 */
export type ApiUrlSource = "configured" | "tunnel" | "tunnel-pending" | "default";

/** Metadata returned by {@link getEffectiveApiUrlWithSource}. */
export interface EffectiveApiUrlInfo {
  /** The URL to show / use. */
  url: string;
  /** Where it came from; see {@link ApiUrlSource}. */
  source: ApiUrlSource;
  /** True when `source === "tunnel"` (caller may warn the URL is ephemeral). */
  isTunnel: boolean;
}

/**
 * Same precedence as {@link getEffectiveApiUrl} but also reports the source.
 * Callers that need to display a "tunnel URL is temporary" warning (e.g. the
 * `/url` bot command) should use this instead.
 */
export async function getEffectiveApiUrlWithSource(): Promise<EffectiveApiUrlInfo> {
  const configured = await getRawConfiguredApiUrl();
  if (configured) {
    return { url: configured, source: "configured", isTunnel: false };
  }
  const tunnel = getTunnelUrl();
  if (tunnel) {
    return { url: tunnel, source: "tunnel", isTunnel: true };
  }
  // If a tunnel is requested but URL hasn't arrived yet, flag it so callers
  // can say "connecting..." instead of showing a useless localhost URL.
  if (config.CLOUDFLARE_TUNNEL === "quick") {
    return { url: config.DEFAULT_API_URL, source: "tunnel-pending", isTunnel: false };
  }
  return { url: config.DEFAULT_API_URL, source: "default", isTunnel: false };
}
