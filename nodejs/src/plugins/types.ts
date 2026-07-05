/**
 * Public type contract for the Node.js plugin system.
 *
 * This is the most important file for plugin authors: every type a
 * plugin implementation touches (its own shape, the `context` passed
 * to its lifecycle hooks, the grammY bot/command types) is defined
 * here and re-exported unchanged via `./index.js`. Treat changes to
 * this file as public API changes — plugin-example/ and any
 * third-party plugin (e.g. s12ryt/s12ryt-nodejs-plugin-example) rely
 * on these shapes.
 *
 * Naming note: `NodeJsPluginContext` and `PluginContext` are
 * deliberately different things despite the similar names:
 * - `NodeJsPluginContext` is the grammY `Context` (+ conversations
 *   flavor) used for *bot update* handlers — e.g. the `ctx` parameter
 *   of a `registerBotCommand({ handler })` callback.
 * - `PluginContext` is *this plugin runtime's* context object —
 *   passed to `setup`/`onStart`/`onStop`, exposing `bot`/`router`/
 *   `app`/`logger`/`services` and the registration helpers.
 * If you're looking for "the thing passed to my plugin's setup
 * function", that's `PluginContext`, not `NodeJsPluginContext`.
 */

import type { Application, RequestHandler, Router } from "express";
import type { Bot, Context } from "grammy";
import type { BotCommand } from "grammy/types";
import type { ConversationFlavor } from "@grammyjs/conversations";
import type { Config } from "../config.js";
import type { PluginServices } from "./services.js";

/** grammY `Context` (+ conversations flavor) for bot update/command handlers. See the file header for how this differs from `PluginContext`. */
export type NodeJsPluginContext = Context & ConversationFlavor;

/** The shared bot instance, typed with this project's `NodeJsPluginContext`. */
export type NodeJsPluginBot = Bot<NodeJsPluginContext>;

/** Prefixed console logger (`[plugin:<name>]`) handed to every plugin via `PluginContext.logger`. */
export type PluginLogger = {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
};

export type RegisterBotCommandOptions = BotCommand & {
  /**
   * When provided, this function is registered as a grammY command handler.
   * The handler runs in the normal bot middleware chain, so plugins should
   * still perform their own permission checks.
   */
  handler?: (ctx: NodeJsPluginContext) => unknown | Promise<unknown>;
};

/**
 * The object passed to a plugin's `setup`/`onStart`/`onStop` hooks.
 * This is the plugin's entire surface for interacting with the host
 * app: mount HTTP routes on `router`, register bot commands via
 * `registerBotCommand`, and prefer `services` (auth/storage/events/
 * scheduler/providers/db) over reaching into host internals directly.
 */
export type PluginContext = {
  name: string;
  version: string;
  config: Readonly<Config>;
  bot: NodeJsPluginBot;
  /** Router mounted under /plugins/<plugin-id>. */
  router: Router;
  /** Advanced escape hatch. Prefer router for normal plugin endpoints. */
  app: Application;
  logger: PluginLogger;
  services: PluginServices;
  registerBotCommand(command: RegisterBotCommandOptions): void;
  usePluginMiddleware(handler: RequestHandler): void;
};

/**
 * The shape every plugin's default (or `plugin`-named) export must
 * match. `setup` runs once at plugin activation (after the bot/app are
 * bound); `onStart`/`onStop` run around the host process's start/shutdown.
 * A hook that throws/rejects is logged via `PluginContext.logger.error`
 * and does not abort other plugins' lifecycle.
 */
export type NodeJsPlugin = {
  name: string;
  version: string;
  description?: string;
  setup?(context: PluginContext): unknown | Promise<unknown>;
  onStart?(context: PluginContext): unknown | Promise<unknown>;
  onStop?(context: PluginContext): unknown | Promise<unknown>;
};

/** A plugin resolved from disk: its normalized route `id`, absolute `source` path, and validated `plugin` export. */
export type LoadedNodeJsPlugin = {
  id: string;
  source: string;
  plugin: NodeJsPlugin;
};
