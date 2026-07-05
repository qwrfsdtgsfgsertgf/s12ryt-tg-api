import express, { type Application, type RequestHandler, type Router } from "express";
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { config } from "../config.js";
import { cleanupPluginServices, createPluginServices } from "./services.js";
import type {
  LoadedNodeJsPlugin,
  NodeJsPlugin,
  NodeJsPluginBot,
  PluginContext,
  PluginLogger,
  RegisterBotCommandOptions,
} from "./types.js";

type PluginModule = {
  default?: unknown;
  plugin?: unknown;
};

export type PluginInstallKind = "upload" | "github" | "env";

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

export type PluginInstallInput = {
  filename: string;
  content: string;
  kind: Exclude<PluginInstallKind, "env">;
  url?: string;
};

const MAX_PLUGIN_BYTES = 1024 * 1024;
const pluginRootRouter = express.Router();
const loadedPlugins: LoadedNodeJsPlugin[] = [];
const installedPlugins: InstalledPluginRecord[] = [];
const pluginContexts = new Map<string, PluginContext>();
const botCommands: RegisterBotCommandOptions[] = [];
let appRef: Application | null = null;
let botRef: NodeJsPluginBot | null = null;
let pluginsLoaded = false;
let pluginsInitialized = false;
let pluginsStarted = false;

function getPluginDataDir(): string {
  return path.resolve(process.cwd(), "data", "plugins");
}

function getManifestPath(): string {
  return path.join(getPluginDataDir(), "manifest.json");
}

function createPluginLogger(pluginName: string): PluginLogger {
  const prefix = `[plugin:${pluginName}]`;
  return {
    info: (message, meta) => meta === undefined ? console.log(`${prefix} ${message}`) : console.log(`${prefix} ${message}`, meta),
    warn: (message, meta) => meta === undefined ? console.warn(`${prefix} ${message}`) : console.warn(`${prefix} ${message}`, meta),
    error: (message, meta) => meta === undefined ? console.error(`${prefix} ${message}`) : console.error(`${prefix} ${message}`, meta),
  };
}

function normalizePluginId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function sanitizeFileStem(value: string): string {
  const stem = path.basename(value).replace(/\.(m?js)$/i, "");
  const sanitized = stem.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.slice(0, 64) || "plugin";
}

function assertPluginFilename(filename: string): void {
  const ext = path.extname(filename).toLowerCase();
  if (ext !== ".js" && ext !== ".mjs") {
    throw new Error("插件檔案必須是 .js 或 .mjs ESM 檔案");
  }
}

function assertPluginSize(content: string): void {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes === 0) throw new Error("插件檔案不能是空檔案");
  if (bytes > MAX_PLUGIN_BYTES) throw new Error("插件檔案超過 1MB 上限");
}

function resolvePluginPath(source: string): string {
  return path.isAbsolute(source) ? source : path.resolve(process.cwd(), source);
}

async function readEntryFromJson(filePath: string, fields: string[]): Promise<string | null> {
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

async function resolvePluginEntryPath(source: string): Promise<string | null> {
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

function validatePlugin(candidate: unknown, source: string): NodeJsPlugin {
  if (!candidate || typeof candidate !== "object") {
    throw new Error(`Plugin at ${source} must export an object`);
  }

  const plugin = candidate as Partial<NodeJsPlugin>;
  if (typeof plugin.name !== "string" || !plugin.name.trim()) {
    throw new Error(`Plugin at ${source} must define a non-empty name`);
  }
  if (typeof plugin.version !== "string" || !plugin.version.trim()) {
    throw new Error(`Plugin ${plugin.name} must define a non-empty version`);
  }

  for (const hook of ["setup", "onStart", "onStop"] as const) {
    if (plugin[hook] !== undefined && typeof plugin[hook] !== "function") {
      throw new Error(`Plugin ${plugin.name} hook ${hook} must be a function`);
    }
  }

  return plugin as NodeJsPlugin;
}

function getPluginExport(module: PluginModule): unknown {
  return module.default ?? module.plugin;
}

async function readManifest(): Promise<InstalledPluginRecord[]> {
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

async function writeManifest(records: InstalledPluginRecord[]): Promise<void> {
  await fs.mkdir(getPluginDataDir(), { recursive: true });
  await fs.writeFile(getManifestPath(), JSON.stringify(records, null, 2), "utf8");
}

async function refreshInstalledPlugins(): Promise<InstalledPluginRecord[]> {
  installedPlugins.splice(0, installedPlugins.length, ...await readManifest());
  return installedPlugins;
}

function hasPluginId(id: string): boolean {
  return loadedPlugins.some((item) => item.id === id) || installedPlugins.some((item) => item.id === id);
}

async function importPluginFromPath(source: string, fresh = false): Promise<LoadedNodeJsPlugin> {
  const absolutePath = resolvePluginPath(source);
  const href = pathToFileURL(absolutePath).href + (fresh ? `?v=${Date.now()}` : "");
  const module = await import(href) as PluginModule;
  const plugin = validatePlugin(getPluginExport(module), absolutePath);
  const id = normalizePluginId(plugin.name);
  if (!id) throw new Error(`Plugin ${plugin.name} produced an empty route id`);
  return { id, source: absolutePath, plugin };
}

async function callPluginHook(pluginId: string, hook: keyof Pick<NodeJsPlugin, "setup" | "onStart" | "onStop">): Promise<void> {
  const context = pluginContexts.get(pluginId);
  const loaded = loadedPlugins.find((item) => item.id === pluginId);
  if (!context || !loaded) return;

  const fn = loaded.plugin[hook];
  if (!fn) return;

  try {
    await fn(context);
  } catch (err) {
    context.logger.error(`${hook} failed`, err);
  }
}

async function activatePlugin(loaded: LoadedNodeJsPlugin): Promise<void> {
  if (pluginContexts.has(loaded.id)) return;
  if (!appRef || !botRef) {
    throw new Error("Plugin runtime is not initialized yet.");
  }

  const logger = createPluginLogger(loaded.plugin.name);
  const services = createPluginServices(loaded.id, logger);
  const router = express.Router();
  const context: PluginContext = {
    name: loaded.plugin.name,
    version: loaded.plugin.version,
    config,
    bot: botRef,
    router,
    app: appRef,
    logger,
    services,
    registerBotCommand(command) {
      botCommands.push(command);
      if (command.handler && botRef) {
        botRef.command(command.command, command.handler);
      }
    },
    usePluginMiddleware(handler: RequestHandler) {
      router.use(handler);
    },
  };

  pluginContexts.set(loaded.id, context);
  pluginRootRouter.use(`/${loaded.id}`, router);
  await callPluginHook(loaded.id, "setup");
}

export function getPluginRootRouter(): Router {
  return pluginRootRouter;
}

export function bindPluginApp(app: Application): void {
  appRef = app;
}

export async function loadNodeJsPlugins(pluginPaths: string[] = config.NODEJS_PLUGIN_PATHS): Promise<LoadedNodeJsPlugin[]> {
  if (pluginsLoaded) return loadedPlugins;
  pluginsLoaded = true;

  await refreshInstalledPlugins();
  const sources = [
    ...pluginPaths.map((source) => ({ source, kind: "env" as const })),
    ...installedPlugins.map((record) => ({ source: record.filePath, kind: record.kind })),
  ];

  if (sources.length === 0) {
    console.log("[plugins] No Node.js plugins configured.");
    return loadedPlugins;
  }

  const ids = new Set<string>();

  for (const item of sources) {
    const absolutePath = await resolvePluginEntryPath(item.source);
    if (!absolutePath) continue;

    try {
      const loaded = await importPluginFromPath(absolutePath);
      if (ids.has(loaded.id) || loadedPlugins.some((plugin) => plugin.id === loaded.id)) {
        throw new Error(`Duplicate plugin id: ${loaded.id}`);
      }
      ids.add(loaded.id);
      loadedPlugins.push(loaded);
      console.log(`[plugins] Loaded ${loaded.plugin.name}@${loaded.plugin.version} from ${absolutePath}`);
    } catch (err) {
      console.error(`[plugins] Failed to load ${absolutePath}:`, err);
    }
  }

  return loadedPlugins;
}

export async function initializeNodeJsPlugins(bot: NodeJsPluginBot): Promise<void> {
  botRef = bot;
  if (pluginsInitialized) return;
  pluginsInitialized = true;

  await loadNodeJsPlugins();
  if (loadedPlugins.length === 0) return;
  if (!appRef) {
    throw new Error("Plugin app is not bound. Call bindPluginApp(app) before initializeNodeJsPlugins().");
  }

  for (const loaded of loadedPlugins) {
    await activatePlugin(loaded);
  }
}

export async function startNodeJsPlugins(): Promise<void> {
  pluginsStarted = true;
  for (const loaded of loadedPlugins) {
    await callPluginHook(loaded.id, "onStart");
  }
}

export async function shutdownNodeJsPlugins(): Promise<void> {
  for (const loaded of [...loadedPlugins].reverse()) {
    await callPluginHook(loaded.id, "onStop");
    cleanupPluginServices(loaded.id);
  }
}

export function getPluginBotCommands(): RegisterBotCommandOptions[] {
  return [...botCommands];
}

export async function listNodeJsPlugins(): Promise<{
  loaded: Array<{ id: string; name: string; version: string; description?: string; source: string; active: boolean }>;
  installed: InstalledPluginRecord[];
}> {
  await refreshInstalledPlugins();
  return {
    loaded: loadedPlugins.map((item) => ({
      id: item.id,
      name: item.plugin.name,
      version: item.plugin.version,
      description: item.plugin.description,
      source: item.source,
      active: pluginContexts.has(item.id),
    })),
    installed: [...installedPlugins],
  };
}

export async function installNodeJsPluginFromContent(input: PluginInstallInput): Promise<InstalledPluginRecord> {
  assertPluginFilename(input.filename);
  assertPluginSize(input.content);

  await fs.mkdir(getPluginDataDir(), { recursive: true });

  const ext = path.extname(input.filename).toLowerCase();
  const tempPath = path.join(getPluginDataDir(), `install-${Date.now()}-${sanitizeFileStem(input.filename)}${ext}`);
  await fs.writeFile(tempPath, input.content, "utf8");

  try {
    await refreshInstalledPlugins();
    const loaded = await importPluginFromPath(tempPath, true);
    if (hasPluginId(loaded.id)) throw new Error(`插件 ${loaded.id} 已安裝或已載入`);

    const finalPath = path.join(getPluginDataDir(), `${loaded.id}${ext}`);
    await fs.rename(tempPath, finalPath);
    const finalLoaded = await importPluginFromPath(finalPath, true);
    loadedPlugins.push(finalLoaded);

    const record: InstalledPluginRecord = {
      id: finalLoaded.id,
      name: finalLoaded.plugin.name,
      version: finalLoaded.plugin.version,
      description: finalLoaded.plugin.description,
      source: finalLoaded.source,
      filePath: finalPath,
      kind: input.kind,
      url: input.url,
      installedAt: new Date().toISOString(),
    };

    installedPlugins.push(record);
    await writeManifest(installedPlugins);

    if (pluginsInitialized) {
      await activatePlugin(finalLoaded);
      if (pluginsStarted) await callPluginHook(finalLoaded.id, "onStart");
    }

    return record;
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}
