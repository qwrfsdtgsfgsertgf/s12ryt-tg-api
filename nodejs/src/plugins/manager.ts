/**
 * Node.js plugin runtime orchestrator.
 *
 * Language convention for thrown/logged messages in this file and its
 * sibling plugin modules (pluginNaming.ts, pluginPathResolver.ts,
 * pluginManifest.ts, services.ts):
 *
 * - English: messages describing the *plugin author's contract* (a
 *   malformed exported plugin object, an invalid services API call,
 *   an internal runtime invariant) or boot-time/ops console
 *   diagnostics. These are aimed at developers reading logs or
 *   writing plugins, so they stay in English for consistency with the
 *   rest of the (English) developer-facing API surface. Several exact
 *   substrings here are asserted on by nodejs/tests/pluginManager.test.ts
 *   and nodejs/tests/pluginServices.test.ts — do not reword them.
 * - Traditional Chinese: messages describing an *admin-facing
 *   operational outcome* surfaced through the Web Console install
 *   flow (bad file extension/size, duplicate plugin id). These are
 *   shown directly to the operator, not to a plugin author.
 *
 * The mutable runtime state (loaded/installed plugins, per-plugin
 * contexts, registered bot commands, the bound app/bot, lifecycle
 * flags) lives in `pluginRegistry` (./pluginRegistry.js) — this file
 * only contains orchestration logic on top of that registry plus the
 * naming/path/manifest helper modules.
 */

import express, { type Application, type RequestHandler, type Router } from "express";
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { config } from "../config.js";
import { getPluginDataDir, type InstalledPluginRecord, type PluginInstallInput } from "./pluginManifest.js";
import { assertPluginFilename, assertPluginSize, normalizePluginId, sanitizeFileStem } from "./pluginNaming.js";
import { resolvePluginEntryPath, resolvePluginPath } from "./pluginPathResolver.js";
import { pluginRegistry } from "./pluginRegistry.js";
import { cleanupPluginServices, createPluginServices } from "./services.js";
import type {
  LoadedNodeJsPlugin,
  NodeJsPlugin,
  NodeJsPluginBot,
  PluginContext,
  PluginLogger,
  RegisterBotCommandOptions,
} from "./types.js";

export type { InstalledPluginRecord, PluginInstallInput, PluginInstallKind } from "./pluginManifest.js";

type PluginModule = {
  default?: unknown;
  plugin?: unknown;
};

function createPluginLogger(pluginName: string): PluginLogger {
  const prefix = `[plugin:${pluginName}]`;
  return {
    info: (message, meta) => (meta === undefined ? console.log(`${prefix} ${message}`) : console.log(`${prefix} ${message}`, meta)),
    warn: (message, meta) => (meta === undefined ? console.warn(`${prefix} ${message}`) : console.warn(`${prefix} ${message}`, meta)),
    error: (message, meta) => (meta === undefined ? console.error(`${prefix} ${message}`) : console.error(`${prefix} ${message}`, meta)),
  };
}

/** Throws (English, plugin-author contract) if the exported value isn't a well-formed `NodeJsPlugin`. */
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

/** Dynamically imports a plugin entry file and validates its export shape. */
async function importPluginFromPath(source: string, fresh = false): Promise<LoadedNodeJsPlugin> {
  const absolutePath = resolvePluginPath(source);
  const href = pathToFileURL(absolutePath).href + (fresh ? `?v=${Date.now()}` : "");
  const module = (await import(href)) as PluginModule;
  const plugin = validatePlugin(getPluginExport(module), absolutePath);
  const id = normalizePluginId(plugin.name);
  if (!id) throw new Error(`Plugin ${plugin.name} produced an empty route id`);
  return { id, source: absolutePath, plugin };
}

/** Invokes a lifecycle hook on a loaded+activated plugin; hook errors are logged, not thrown. */
async function callPluginHook(pluginId: string, hook: keyof Pick<NodeJsPlugin, "setup" | "onStart" | "onStop">): Promise<void> {
  const context = pluginRegistry.getContext(pluginId);
  const loaded = pluginRegistry.findLoadedPlugin(pluginId);
  if (!context || !loaded) return;

  const fn = loaded.plugin[hook];
  if (!fn) return;

  try {
    await fn(context);
  } catch (err) {
    context.logger.error(`${hook} failed`, err);
  }
}

/** Builds a plugin's `PluginContext`, mounts its router, and runs its `setup` hook (idempotent). */
async function activatePlugin(loaded: LoadedNodeJsPlugin): Promise<void> {
  if (pluginRegistry.hasContext(loaded.id)) return;
  const appRef = pluginRegistry.getApp();
  const botRef = pluginRegistry.getBot();
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
      pluginRegistry.addBotCommand(command);
      const bot = pluginRegistry.getBot();
      if (command.handler && bot) {
        bot.command(command.command, command.handler);
      }
    },
    usePluginMiddleware(handler: RequestHandler) {
      router.use(handler);
    },
  };

  pluginRegistry.setContext(loaded.id, context);
  pluginRegistry.getRouter().use(`/${loaded.id}`, router);
  await callPluginHook(loaded.id, "setup");
}

/** The shared Express router that all activated plugins are mounted under. */
export function getPluginRootRouter(): Router {
  return pluginRegistry.getRouter();
}

/** Binds the main Express app so plugin contexts can reference it. Call once at boot. */
export function bindPluginApp(app: Application): void {
  pluginRegistry.bindApp(app);
}

/**
 * Discovers and imports plugins from `pluginPaths` (env-configured) plus
 * any manifest-installed plugins. Idempotent — safe to call multiple times.
 */
export async function loadNodeJsPlugins(pluginPaths: string[] = config.NODEJS_PLUGIN_PATHS): Promise<LoadedNodeJsPlugin[]> {
  if (pluginRegistry.isLoaded()) return pluginRegistry.getLoadedPlugins();
  pluginRegistry.markLoaded();

  await pluginRegistry.refreshInstalledPlugins();
  const sources = [
    ...pluginPaths.map((source) => ({ source, kind: "env" as const })),
    ...pluginRegistry.getInstalledPlugins().map((record) => ({ source: record.filePath, kind: record.kind })),
  ];

  if (sources.length === 0) {
    console.log("[plugins] No Node.js plugins configured.");
    return pluginRegistry.getLoadedPlugins();
  }

  const ids = new Set<string>();

  for (const item of sources) {
    const absolutePath = await resolvePluginEntryPath(item.source);
    if (!absolutePath) continue;

    try {
      const loaded = await importPluginFromPath(absolutePath);
      if (ids.has(loaded.id) || pluginRegistry.hasLoadedPlugin(loaded.id)) {
        throw new Error(`Duplicate plugin id: ${loaded.id}`);
      }
      ids.add(loaded.id);
      pluginRegistry.addLoadedPlugin(loaded);
      console.log(`[plugins] Loaded ${loaded.plugin.name}@${loaded.plugin.version} from ${absolutePath}`);
    } catch (err) {
      console.error(`[plugins] Failed to load ${absolutePath}:`, err);
    }
  }

  return pluginRegistry.getLoadedPlugins();
}

/**
 * Binds the bot, loads plugins (if not already loaded), and activates
 * each one. Idempotent — subsequent calls only rebind the bot reference.
 */
export async function initializeNodeJsPlugins(bot: NodeJsPluginBot): Promise<void> {
  pluginRegistry.bindBot(bot);
  if (pluginRegistry.isInitialized()) return;
  pluginRegistry.markInitialized();

  await loadNodeJsPlugins();
  const loadedPlugins = pluginRegistry.getLoadedPlugins();
  if (loadedPlugins.length === 0) return;
  if (!pluginRegistry.getApp()) {
    throw new Error("Plugin app is not bound. Call bindPluginApp(app) before initializeNodeJsPlugins().");
  }

  for (const loaded of loadedPlugins) {
    await activatePlugin(loaded);
  }
}

/** Runs every activated plugin's `onStart` hook. */
export async function startNodeJsPlugins(): Promise<void> {
  pluginRegistry.markStarted();
  for (const loaded of pluginRegistry.getLoadedPlugins()) {
    await callPluginHook(loaded.id, "onStart");
  }
}

/** Runs every activated plugin's `onStop` hook (reverse load order) and releases its services. */
export async function shutdownNodeJsPlugins(): Promise<void> {
  for (const loaded of pluginRegistry.getLoadedPlugins().reverse()) {
    await callPluginHook(loaded.id, "onStop");
    cleanupPluginServices(loaded.id);
  }
}

/** Snapshot of bot commands registered by plugins via `context.registerBotCommand`. */
export function getPluginBotCommands(): RegisterBotCommandOptions[] {
  return pluginRegistry.getBotCommands();
}

/** Returns currently loaded (in-memory) and installed (manifest-persisted) plugin summaries. */
export async function listNodeJsPlugins(): Promise<{
  loaded: Array<{ id: string; name: string; version: string; description?: string; source: string; active: boolean }>;
  installed: InstalledPluginRecord[];
}> {
  await pluginRegistry.refreshInstalledPlugins();
  return {
    loaded: pluginRegistry.getLoadedPlugins().map((item) => ({
      id: item.id,
      name: item.plugin.name,
      version: item.plugin.version,
      description: item.plugin.description,
      source: item.source,
      active: pluginRegistry.hasContext(item.id),
    })),
    installed: pluginRegistry.getInstalledPlugins(),
  };
}

/**
 * Validates, writes to disk, and registers a plugin uploaded/fetched at
 * runtime (Web Console upload or GitHub install). Activates it immediately
 * if the plugin runtime is already initialized.
 */
export async function installNodeJsPluginFromContent(input: PluginInstallInput): Promise<InstalledPluginRecord> {
  assertPluginFilename(input.filename);
  assertPluginSize(input.content);

  await fs.mkdir(getPluginDataDir(), { recursive: true });

  const ext = path.extname(input.filename).toLowerCase();
  const tempPath = path.join(getPluginDataDir(), `install-${Date.now()}-${sanitizeFileStem(input.filename)}${ext}`);
  await fs.writeFile(tempPath, input.content, "utf8");

  try {
    await pluginRegistry.refreshInstalledPlugins();
    const loaded = await importPluginFromPath(tempPath, true);
    if (pluginRegistry.hasPluginId(loaded.id)) throw new Error(`插件 ${loaded.id} 已安裝或已載入`);

    const finalPath = path.join(getPluginDataDir(), `${loaded.id}${ext}`);
    await fs.rename(tempPath, finalPath);
    const finalLoaded = await importPluginFromPath(finalPath, true);
    pluginRegistry.addLoadedPlugin(finalLoaded);

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

    await pluginRegistry.addInstalledPlugin(record);

    if (pluginRegistry.isInitialized()) {
      await activatePlugin(finalLoaded);
      if (pluginRegistry.isStarted()) await callPluginHook(finalLoaded.id, "onStart");
    }

    return record;
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}
