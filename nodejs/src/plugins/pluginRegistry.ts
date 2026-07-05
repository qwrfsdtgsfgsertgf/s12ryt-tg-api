/**
 * Central mutable-state container for the Node.js plugin runtime.
 *
 * This class replaces the module-level `let`/`const` globals that used
 * to live directly in manager.ts (plugin router, loaded/installed
 * plugin lists, per-plugin contexts, registered bot commands, the
 * bound Express app/bot, and lifecycle flags). It is pure bookkeeping
 * with no user-facing error messages of its own, so it has no language
 * convention to document — see manager.ts's header for the
 * English/Chinese error message convention that governs the callers
 * that use this registry.
 *
 * A single instance is exported as `pluginRegistry`. Because this is a
 * normal ES module, `vi.resetModules()` in tests causes a fresh
 * `PluginRegistry` instance to be constructed the next time anything
 * (including manager.ts) imports this file — state isolation between
 * test cases is preserved exactly as it was before this refactor.
 */

import express, { type Application, type Router } from "express";
import { readManifest, writeManifest, type InstalledPluginRecord } from "./pluginManifest.js";
import type { LoadedNodeJsPlugin, NodeJsPluginBot, PluginContext, RegisterBotCommandOptions } from "./types.js";

export class PluginRegistry {
  private readonly router: Router = express.Router();
  private readonly loaded: LoadedNodeJsPlugin[] = [];
  private readonly installed: InstalledPluginRecord[] = [];
  private readonly contexts = new Map<string, PluginContext>();
  private readonly commands: RegisterBotCommandOptions[] = [];
  private app: Application | null = null;
  private bot: NodeJsPluginBot | null = null;
  private loadedFlag = false;
  private initializedFlag = false;
  private startedFlag = false;

  // --- plugin root router ---------------------------------------------------

  getRouter(): Router {
    return this.router;
  }

  // --- app / bot binding ------------------------------------------------------

  bindApp(app: Application): void {
    this.app = app;
  }

  getApp(): Application | null {
    return this.app;
  }

  bindBot(bot: NodeJsPluginBot): void {
    this.bot = bot;
  }

  getBot(): NodeJsPluginBot | null {
    return this.bot;
  }

  // --- lifecycle flags ---------------------------------------------------------

  isLoaded(): boolean {
    return this.loadedFlag;
  }

  markLoaded(): void {
    this.loadedFlag = true;
  }

  isInitialized(): boolean {
    return this.initializedFlag;
  }

  markInitialized(): void {
    this.initializedFlag = true;
  }

  isStarted(): boolean {
    return this.startedFlag;
  }

  markStarted(): void {
    this.startedFlag = true;
  }

  // --- loaded plugins -------------------------------------------------------

  /** Returns a shallow copy; use {@link addLoadedPlugin} to mutate. */
  getLoadedPlugins(): LoadedNodeJsPlugin[] {
    return [...this.loaded];
  }

  addLoadedPlugin(loaded: LoadedNodeJsPlugin): void {
    this.loaded.push(loaded);
  }

  findLoadedPlugin(id: string): LoadedNodeJsPlugin | undefined {
    return this.loaded.find((item) => item.id === id);
  }

  hasLoadedPlugin(id: string): boolean {
    return this.loaded.some((item) => item.id === id);
  }

  // --- installed plugins (manifest-backed) -----------------------------------

  /** Returns a shallow copy; use {@link addInstalledPlugin} to mutate. */
  getInstalledPlugins(): InstalledPluginRecord[] {
    return [...this.installed];
  }

  /** Re-reads manifest.json from disk and replaces the in-memory list in place. */
  async refreshInstalledPlugins(): Promise<InstalledPluginRecord[]> {
    this.installed.splice(0, this.installed.length, ...(await readManifest()));
    return [...this.installed];
  }

  hasInstalledPlugin(id: string): boolean {
    return this.installed.some((item) => item.id === id);
  }

  /** Appends the record in memory and persists the full list to manifest.json. */
  async addInstalledPlugin(record: InstalledPluginRecord): Promise<void> {
    this.installed.push(record);
    await writeManifest(this.installed);
  }

  // --- combined lookup ---------------------------------------------------------

  hasPluginId(id: string): boolean {
    return this.hasLoadedPlugin(id) || this.hasInstalledPlugin(id);
  }

  // --- per-plugin activation contexts -------------------------------------------

  getContext(id: string): PluginContext | undefined {
    return this.contexts.get(id);
  }

  setContext(id: string, context: PluginContext): void {
    this.contexts.set(id, context);
  }

  hasContext(id: string): boolean {
    return this.contexts.has(id);
  }

  // --- registered bot commands ---------------------------------------------------

  getBotCommands(): RegisterBotCommandOptions[] {
    return [...this.commands];
  }

  addBotCommand(command: RegisterBotCommandOptions): void {
    this.commands.push(command);
  }
}

/** Singleton registry backing the manager.ts orchestration functions. */
export const pluginRegistry = new PluginRegistry();
