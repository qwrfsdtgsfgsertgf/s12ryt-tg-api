/**
 * Unit tests for src/plugins/manager.ts plugin path resolution.
 *
 * These tests isolate process.cwd() so plugin manifest lookup never touches the
 * real workspace data/plugins directory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let tmpDir: string;
const originalCwd = process.cwd();

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "s12ryt-plugin-manager-"));
}

async function loadFreshManager(): Promise<typeof import("../src/plugins/manager.js")> {
  vi.resetModules();
  return import("../src/plugins/manager.js");
}

describe("Plugin manager path loading", () => {
  beforeEach(() => {
    tmpDir = makeTempDir();
    process.chdir(tmpDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    vi.resetModules();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors on Windows file handles.
    }
  });

  it("skips missing plugin paths without invoking dynamic import", async () => {
    const missingPath = path.join(tmpDir, "plugin");
    const { loadNodeJsPlugins } = await loadFreshManager();

    const loaded = await loadNodeJsPlugins([missingPath]);

    expect(loaded).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("path does not exist"));
    expect(console.error).not.toHaveBeenCalled();
  });

  it("skips non-JavaScript plugin entries before importing", async () => {
    const badEntry = path.join(tmpDir, "plugin.txt");
    fs.writeFileSync(badEntry, "not a module", "utf8");
    const { loadNodeJsPlugins } = await loadFreshManager();

    const loaded = await loadNodeJsPlugins([badEntry]);

    expect(loaded).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(".js or .mjs"));
    expect(console.error).not.toHaveBeenCalled();
  });

  it("loads a plugin directory through plugin.json main", async () => {
    const pluginDir = path.join(tmpDir, "directory-plugin");
    const distDir = path.join(pluginDir, "dist");
    const entryPath = path.join(distDir, "index.js");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify({ main: "dist/index.js" }), "utf8");
    fs.writeFileSync(
      entryPath,
      "export default { name: 'Directory Plugin', version: '1.0.0' };\n",
      "utf8",
    );
    const { loadNodeJsPlugins } = await loadFreshManager();

    const loaded = await loadNodeJsPlugins([pluginDir]);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe("directory-plugin");
    expect(path.normalize(loaded[0]?.source ?? "")).toBe(path.normalize(entryPath));
    expect(console.error).not.toHaveBeenCalled();
  });
});
