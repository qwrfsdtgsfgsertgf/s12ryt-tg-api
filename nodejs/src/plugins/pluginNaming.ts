/**
 * Plugin id / filename normalization + validation helpers.
 *
 * Language convention (see manager.ts header for the full rule):
 * these functions are called during *admin-facing* install flows
 * (Web Console upload / GitHub install), so thrown errors here are
 * Traditional Chinese for direct display to the operator.
 */

import path from "path";

const MAX_PLUGIN_BYTES = 10 * 1024 * 1024;

/**
 * Normalize a plugin's declared `name` into a URL-safe, stable route id.
 * e.g. "My Cool Plugin!!" -> "my-cool-plugin"
 */
export function normalizePluginId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Sanitize an arbitrary filename into a safe file stem (no extension),
 * used when writing installed plugin files to disk.
 */
export function sanitizeFileStem(value: string): string {
  const stem = path.basename(value).replace(/\.(m?js)$/i, "");
  const sanitized = stem.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.slice(0, 64) || "plugin";
}

/** Throws (Chinese, admin-facing) if the filename isn't a `.js`/`.mjs` ESM file. */
export function assertPluginFilename(filename: string): void {
  const ext = path.extname(filename).toLowerCase();
  if (ext !== ".js" && ext !== ".mjs") {
    throw new Error("插件檔案必須是 .js 或 .mjs ESM 檔案");
  }
}

/** Throws (Chinese, admin-facing) if the plugin file content is empty or exceeds the size cap. */
export function assertPluginSize(content: string): void {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes === 0) throw new Error("插件檔案不能是空檔案");
  if (bytes > MAX_PLUGIN_BYTES) throw new Error("插件檔案超過 10MB 上限");
}
