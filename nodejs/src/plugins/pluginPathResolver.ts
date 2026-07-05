/**
 * Plugin entry-path resolution.
 *
 * Language convention: the console.warn messages here are boot-time /
 * ops-facing diagnostics (English), and several exact substrings are
 * asserted on by nodejs/tests/pluginManager.test.ts — do not translate
 * or reword them ("path does not exist", "directory has no .js/.mjs
 * entry file", "path is not a regular file", "plugin entry must be a
 * .js or .mjs file").
 */

import fs from "fs/promises";
import path from "path";

/** Resolve a plugin source string to an absolute filesystem path. */
export function resolvePluginPath(source: string): string {
  return path.isAbsolute(source) ? source : path.resolve(process.cwd(), source);
}

/**
 * Read a JSON file and return the first non-empty string value found
 * among `fields`, in order. Returns null if the file is missing or the
 * fields aren't present; other read/parse errors are logged (English,
 * ops-facing) and swallowed so boot-time plugin discovery keeps going.
 */
export async function readEntryFromJson(filePath: string, fields: string[]): Promise<string | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const field of fields) {
      const value = parsed[field];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[plugins] Failed to read ${filePath}:`, err);
    }
  }
  return null;
}

/**
 * Resolve a configured plugin `source` (file or directory) down to a
 * concrete `.js`/`.mjs` entry file path. Returns null (after logging an
 * English console.warn) when no valid entry can be found, so callers can
 * skip the source without aborting the whole plugin-loading pass.
 */
export async function resolvePluginEntryPath(source: string): Promise<string | null> {
  const absolutePath = resolvePluginPath(source);
  let stat;

  try {
    stat = await fs.stat(absolutePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn(`[plugins] Skipping ${absolutePath}: path does not exist.`);
      return null;
    }
    throw err;
  }

  if (stat.isDirectory()) {
    const pluginMain = await readEntryFromJson(path.join(absolutePath, "plugin.json"), ["main"]);
    const packageMain = await readEntryFromJson(path.join(absolutePath, "package.json"), ["module", "main"]);
    const candidates = [
      pluginMain,
      packageMain,
      "index.mjs",
      "index.js",
    ].filter((item): item is string => typeof item === "string" && item.length > 0);

    for (const candidate of candidates) {
      const entryPath = path.resolve(absolutePath, candidate);
      const ext = path.extname(entryPath).toLowerCase();
      if (ext !== ".js" && ext !== ".mjs") continue;
      try {
        const entryStat = await fs.stat(entryPath);
        if (entryStat.isFile()) return entryPath;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }

    console.warn(`[plugins] Skipping ${absolutePath}: directory has no .js/.mjs entry file.`);
    return null;
  }

  if (!stat.isFile()) {
    console.warn(`[plugins] Skipping ${absolutePath}: path is not a regular file.`);
    return null;
  }

  const ext = path.extname(absolutePath).toLowerCase();
  if (ext !== ".js" && ext !== ".mjs") {
    console.warn(`[plugins] Skipping ${absolutePath}: plugin entry must be a .js or .mjs file.`);
    return null;
  }

  return absolutePath;
}
