/**
 * Installed plugin manifest persistence.
 *
 * Language convention (see manager.ts header for the full rule): this
 * module only emits ops-facing console.warn diagnostics (English) when
 * the on-disk manifest can't be read; it never throws admin-facing
 * errors itself.
 */

import fs from "fs/promises";
import path from "path";

/** How a plugin was installed: manual upload, GitHub install, or discovered via an env-configured path. */
export type PluginInstallKind = "upload" | "github" | "env";

/** Persisted record for a plugin installed via the Web Console (upload or GitHub). */
export type InstalledPluginRecord = {
  id: string;
  name: string;
  version: string;
  description?: string;
  source: string;
  filePath: string;
  kind: PluginInstallKind;
  url?: string;
  installedAt: string;
};

/** Input accepted by `installNodeJsPluginFromContent` (manager.ts). */
export type PluginInstallInput = {
  filename: string;
  content: string;
  kind: Exclude<PluginInstallKind, "env">;
  url?: string;
};

/** Directory where installed plugin files and the manifest are stored. */
export function getPluginDataDir(): string {
  return path.resolve(process.cwd(), "data", "plugins");
}

/** Path to the installed-plugins manifest JSON file. */
export function getManifestPath(): string {
  return path.join(getPluginDataDir(), "manifest.json");
}

/**
 * Read the installed-plugins manifest, filtering out any malformed
 * entries. Returns an empty array if the manifest doesn't exist yet;
 * other read/parse errors are logged (English, ops-facing) and
 * swallowed so boot-time plugin discovery keeps going.
 */
export async function readManifest(): Promise<InstalledPluginRecord[]> {
  try {
    const raw = await fs.readFile(getManifestPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is InstalledPluginRecord => {
      const record = item as Partial<InstalledPluginRecord>;
      return typeof record.id === "string" && typeof record.name === "string" && typeof record.version === "string" && typeof record.filePath === "string";
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    console.warn("[plugins] Failed to read plugin manifest:", err);
    return [];
  }
}

/** Persist the installed-plugins manifest, creating the data dir if needed. */
export async function writeManifest(records: InstalledPluginRecord[]): Promise<void> {
  await fs.mkdir(getPluginDataDir(), { recursive: true });
  await fs.writeFile(getManifestPath(), JSON.stringify(records, null, 2), "utf8");
}
