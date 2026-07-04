import type { Application, RequestHandler, Router } from "express";
import type { Bot, Context } from "grammy";
import type { BotCommand } from "grammy/types";
import type { ConversationFlavor } from "@grammyjs/conversations";
import type { Config } from "../config.js";

export type NodeJsPluginContext = Context & ConversationFlavor;
export type NodeJsPluginBot = Bot<NodeJsPluginContext>;

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
  registerBotCommand(command: RegisterBotCommandOptions): void;
  usePluginMiddleware(handler: RequestHandler): void;
};

export type NodeJsPlugin = {
  name: string;
  version: string;
  description?: string;
  setup?(context: PluginContext): unknown | Promise<unknown>;
  onStart?(context: PluginContext): unknown | Promise<unknown>;
  onStop?(context: PluginContext): unknown | Promise<unknown>;
};

export type LoadedNodeJsPlugin = {
  id: string;
  source: string;
  plugin: NodeJsPlugin;
};
