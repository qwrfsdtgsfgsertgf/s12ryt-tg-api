/**
 * Public plugin services facade (`context.services`).
 *
 * Language convention (see manager.ts header for the full rule): every
 * thrown message in this file describes a *plugin author's contract*
 * violation (invalid name/key, non-serializable storage value, wrong
 * handler type, out-of-range timer delay, missing auth) — these are
 * part of the developer-facing services API, so they stay in English.
 * Several exact substrings are asserted on by
 * nodejs/tests/pluginServices.test.ts (`/exceeds/`, `/at least/`,
 * `/Trusted/`, `/Authenticated/`) — do not reword them.
 *
 * Event and timer bookkeeping lives in pluginEventBus.ts /
 * pluginTimerRegistry.ts; this file only builds the public per-plugin
 * service facades on top of those (plus direct DB/provider lookups).
 */

import type { Request } from "express";
import { config } from "../config.js";
import type { AuthInfo } from "../api/middleware.js";
import {
  checkModelAllowed,
  getAllowedModels,
  getAllCachedModelNames,
  getDailyUsage,
  getDb,
  getEffectiveLimits,
  getKeysByUser,
  getModelMappings,
  getModelPricesByProvider,
  getMonthlyUsage,
  getProviderById,
  getProviders,
  getUserById,
  getUserByTgId,
  lookupModelCached,
  saveDb,
  type ApiKey,
  type ModelMapping,
  type ModelPrice,
  type Provider,
  type User,
} from "../db/database.js";
import { pluginEventBus, type PluginEventHandler, type PluginUnsubscribe } from "./pluginEventBus.js";
import { pluginTimerRegistry } from "./pluginTimerRegistry.js";
import type { PluginLogger } from "./types.js";

export type { PluginEventHandler, PluginUnsubscribe } from "./pluginEventBus.js";

const NAME_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MAX_NAME_LENGTH = 128;
const MAX_STORAGE_VALUE_BYTES = 256 * 1024;

export type PublicUser = {
  id: number;
  tgUserId: number;
  username: string | null;
  isActive: boolean;
  createdAt: string;
};

export type PublicApiKeyPreview = {
  id: number;
  userId: number;
  preview: string;
  isActive: boolean;
  createdAt: string;
};

export type PublicProvider = {
  id: number;
  name: string;
  apiType: string;
  userAgent: string | null;
  keyStrategy: string | null;
  models: string[];
  enabled: boolean;
  inputPrice: number | null;
  outputPrice: number | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicProviderLookup = {
  providerId: number;
  providerName: string;
  apiType: string;
  userAgent: string | null;
  keyStrategy: string;
  originalModel: string;
  inputPrice: number | null;
  outputPrice: number | null;
};

export type PublicModelPrice = {
  id: number;
  providerId: number;
  model: string;
  inputPrice: number | null;
  outputPrice: number | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicModelMapping = {
  providerId: number;
  providerName: string;
  originalModel: string;
  displayName: string;
};

export type PluginAuthService = {
  isAdminTelegramUser(tgUserId: number | null | undefined): boolean;
  isTrustedTelegramUser(tgUserId: number | null | undefined): boolean;
  requireAdminTelegramUser(tgUserId: number | null | undefined): void;
  requireTrustedTelegramUser(tgUserId: number | null | undefined): void;
  getRequestAuth(req: Request): AuthInfo | null;
  requireRequestAuth(req: Request): AuthInfo;
};

export type PluginStorageService = {
  get<T = unknown>(key: string): T | null;
  set<T = unknown>(key: string, value: T): void;
  delete(key: string): boolean;
  has(key: string): boolean;
  keys(): string[];
  clear(): void;
};

export type PluginEventsService = {
  on<T = unknown>(eventName: string, handler: PluginEventHandler<T>): PluginUnsubscribe;
  once<T = unknown>(eventName: string, handler: PluginEventHandler<T>): PluginUnsubscribe;
  emit<T = unknown>(eventName: string, payload: T): Promise<void>;
  listenerCount(eventName: string): number;
};

export type PluginSchedulerService = {
  setTimeout(handler: () => unknown | Promise<unknown>, delayMs: number): string;
  setInterval(handler: () => unknown | Promise<unknown>, intervalMs: number): string;
  clear(timerId: string): boolean;
  clearAll(): void;
};

export type PluginProvidersService = {
  list(options?: { enabledOnly?: boolean }): PublicProvider[];
  getById(id: number): PublicProvider | null;
  listModels(): string[];
  lookupModel(modelName: string): PublicProviderLookup | null;
  getModelPrices(providerId: number): PublicModelPrice[];
  getModelMappings(): PublicModelMapping[];
};

export type PluginDbService = {
  getUserByTelegramId(tgUserId: number): PublicUser | null;
  getUserById(id: number): PublicUser | null;
  listApiKeyPreviewsByTelegramId(tgUserId: number): PublicApiKeyPreview[];
  getEffectiveLimits(userId: number | string, apiKeyId: number | string): ReturnType<typeof getEffectiveLimits>;
  getDailyUsage(userId: number | string, apiKeyId?: number | string | null): ReturnType<typeof getDailyUsage>;
  getMonthlyUsage(userId: number | string, apiKeyId?: number | string | null): ReturnType<typeof getMonthlyUsage>;
  checkModelAllowed(userId: number | string, apiKeyId: number | string, modelName: string, isAdmin?: boolean): boolean;
  getAllowedModels(userId: number | string, apiKeyId: number | string, allModels: string[], isAdmin?: boolean): string[];
};

export type PluginServices = Readonly<{
  auth: Readonly<PluginAuthService>;
  storage: Readonly<PluginStorageService>;
  events: Readonly<PluginEventsService>;
  scheduler: Readonly<PluginSchedulerService>;
  providers: Readonly<PluginProvidersService>;
  db: Readonly<PluginDbService>;
}>;

/** Shared `Object.freeze` wrapper for every read-only public value this module hands to plugins. */
function freezePublic<T>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function validateName(kind: string, value: string): void {
  if (!value || value.length > MAX_NAME_LENGTH || !NAME_PATTERN.test(value)) {
    throw new Error(`${kind} must be 1-${MAX_NAME_LENGTH} chars and match ${NAME_PATTERN.source}`);
  }
}

function ensureStorageTable(): void {
  getDb().run(`
    CREATE TABLE IF NOT EXISTS plugin_storage (
      plugin_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (plugin_id, key)
    )
  `);
}

function parseJsonValue<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function normalizeDbId(value: number | string, label: string): number {
  const normalized = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return normalized;
}

function normalizeOptionalDbId(value: number | string | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  return normalizeDbId(value, label);
}

function toPublicUser(user: User | undefined): PublicUser | null {
  if (!user) return null;
  return freezePublic({
    id: user.id,
    tgUserId: user.tg_user_id,
    username: user.username,
    isActive: user.is_active === 1,
    createdAt: user.created_at,
  });
}

function maskApiKey(key: string): string {
  return key.length <= 12 ? "..." : `...${key.slice(-12)}`;
}

function toPublicApiKeyPreview(apiKey: ApiKey): PublicApiKeyPreview {
  return freezePublic({
    id: apiKey.id,
    userId: apiKey.user_id,
    preview: maskApiKey(apiKey.key),
    isActive: apiKey.is_active === 1,
    createdAt: apiKey.created_at,
  });
}

function splitModels(models: string): string[] {
  return models.split(",").map((model) => model.trim()).filter(Boolean);
}

function toPublicProvider(provider: Provider | undefined): PublicProvider | null {
  if (!provider) return null;
  return freezePublic({
    id: provider.id,
    name: provider.name,
    apiType: provider.api_type,
    userAgent: provider.user_agent,
    keyStrategy: provider.key_strategy,
    models: freezePublic(splitModels(provider.models)) as string[],
    enabled: provider.enabled === 1,
    inputPrice: provider.input_price,
    outputPrice: provider.output_price,
    createdAt: provider.created_at,
    updatedAt: provider.updated_at,
  });
}

function toPublicModelPrice(price: ModelPrice): PublicModelPrice {
  return freezePublic({
    id: price.id,
    providerId: price.provider_id,
    model: price.model,
    inputPrice: price.input_price,
    outputPrice: price.output_price,
    createdAt: price.created_at,
    updatedAt: price.updated_at,
  });
}

function toPublicModelMapping(mapping: ModelMapping): PublicModelMapping {
  return freezePublic({
    providerId: mapping.provider_id,
    providerName: mapping.provider_name,
    originalModel: mapping.original_model,
    displayName: mapping.display_name,
  });
}

function createAuthService(): PluginAuthService {
  const isTrustedTelegramUser = (tgUserId: number | null | undefined): boolean => {
    if (tgUserId === undefined || tgUserId === null) return false;
    if (tgUserId === config.ADMIN_ID) return true;
    const user = getUserByTgId(tgUserId);
    return user?.is_active === 1;
  };

  return freezePublic({
    isAdminTelegramUser(tgUserId) {
      return tgUserId === config.ADMIN_ID;
    },
    isTrustedTelegramUser,
    requireAdminTelegramUser(tgUserId) {
      if (tgUserId !== config.ADMIN_ID) throw new Error("Admin Telegram user required");
    },
    requireTrustedTelegramUser(tgUserId) {
      if (!isTrustedTelegramUser(tgUserId)) throw new Error("Trusted Telegram user required");
    },
    getRequestAuth(req) {
      return req.auth ?? null;
    },
    requireRequestAuth(req) {
      if (!req.auth) throw new Error("Authenticated API request required");
      return req.auth;
    },
  });
}

function createStorageService(pluginId: string): PluginStorageService {
  const hasStorageKey = (key: string): boolean => {
    validateName("storage key", key);
    ensureStorageTable();
    const row = getDb().exec("SELECT 1 FROM plugin_storage WHERE plugin_id = ? AND key = ? LIMIT 1", [pluginId, key])[0];
    return Boolean(row && row.values.length > 0);
  };

  return freezePublic({
    get<T = unknown>(key: string): T | null {
      validateName("storage key", key);
      ensureStorageTable();
      const row = getDb().exec("SELECT value FROM plugin_storage WHERE plugin_id = ? AND key = ?", [pluginId, key])[0];
      if (!row || row.values.length === 0) return null;
      const raw = row.values[0]?.[0];
      return typeof raw === "string" ? parseJsonValue<T>(raw) : null;
    },
    set<T = unknown>(key: string, value: T): void {
      validateName("storage key", key);
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new Error("storage value must be JSON serializable");
      if (Buffer.byteLength(serialized, "utf8") > MAX_STORAGE_VALUE_BYTES) {
        throw new Error(`storage value exceeds ${MAX_STORAGE_VALUE_BYTES} bytes`);
      }
      ensureStorageTable();
      getDb().run(
        `INSERT INTO plugin_storage (plugin_id, key, value, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
        [pluginId, key, serialized],
      );
      saveDb();
    },
    delete(key: string): boolean {
      validateName("storage key", key);
      ensureStorageTable();
      const existed = hasStorageKey(key);
      getDb().run("DELETE FROM plugin_storage WHERE plugin_id = ? AND key = ?", [pluginId, key]);
      if (existed) saveDb();
      return existed;
    },
    has(key: string): boolean {
      return hasStorageKey(key);
    },
    keys(): string[] {
      ensureStorageTable();
      const row = getDb().exec("SELECT key FROM plugin_storage WHERE plugin_id = ? ORDER BY key", [pluginId])[0];
      if (!row) return [];
      return row.values.map((value) => String(value[0]));
    },
    clear(): void {
      ensureStorageTable();
      getDb().run("DELETE FROM plugin_storage WHERE plugin_id = ?", [pluginId]);
      saveDb();
    },
  });
}

function createEventsService(pluginId: string, logger: PluginLogger): PluginEventsService {
  return freezePublic({
    on<T = unknown>(eventName: string, handler: PluginEventHandler<T>): PluginUnsubscribe {
      validateName("event name", eventName);
      if (typeof handler !== "function") throw new Error("event handler must be a function");
      return pluginEventBus.addListener(eventName, { pluginId, handler: handler as PluginEventHandler, once: false, logger });
    },
    once<T = unknown>(eventName: string, handler: PluginEventHandler<T>): PluginUnsubscribe {
      validateName("event name", eventName);
      if (typeof handler !== "function") throw new Error("event handler must be a function");
      return pluginEventBus.addListener(eventName, { pluginId, handler: handler as PluginEventHandler, once: true, logger });
    },
    async emit<T = unknown>(eventName: string, payload: T): Promise<void> {
      validateName("event name", eventName);
      await pluginEventBus.emit(eventName, payload);
    },
    listenerCount(eventName: string): number {
      validateName("event name", eventName);
      return pluginEventBus.listenerCount(eventName);
    },
  });
}

function createSchedulerService(pluginId: string, logger: PluginLogger): PluginSchedulerService {
  return freezePublic({
    setTimeout(handler, delayMs) {
      if (typeof handler !== "function") throw new Error("timer handler must be a function");
      return pluginTimerRegistry.setTimeout(pluginId, handler, delayMs, logger);
    },
    setInterval(handler, intervalMs) {
      if (typeof handler !== "function") throw new Error("timer handler must be a function");
      return pluginTimerRegistry.setInterval(pluginId, handler, intervalMs, logger);
    },
    clear(timerId) {
      return pluginTimerRegistry.clear(pluginId, timerId);
    },
    clearAll() {
      pluginTimerRegistry.clearAllForPlugin(pluginId);
    },
  });
}

function createProvidersService(): PluginProvidersService {
  return freezePublic({
    list(options = {}) {
      return getProviders(Boolean(options.enabledOnly)).map((provider) => toPublicProvider(provider)).filter((provider): provider is PublicProvider => provider !== null);
    },
    getById(id) {
      return toPublicProvider(getProviderById(id));
    },
    listModels() {
      return freezePublic([...getAllCachedModelNames()]) as string[];
    },
    lookupModel(modelName) {
      const provider = lookupModelCached(modelName);
      if (!provider) return null;
      return freezePublic({
        providerId: provider.providerId,
        providerName: provider.providerName,
        apiType: provider.providerType,
        userAgent: provider.userAgent,
        keyStrategy: provider.keyStrategy,
        originalModel: provider.originalModel,
        inputPrice: provider.inputPrice,
        outputPrice: provider.outputPrice,
      });
    },
    getModelPrices(providerId) {
      return getModelPricesByProvider(providerId).map(toPublicModelPrice);
    },
    getModelMappings() {
      return getModelMappings().map(toPublicModelMapping);
    },
  });
}

function createDbService(): PluginDbService {
  return freezePublic({
    getUserByTelegramId(tgUserId) {
      return toPublicUser(getUserByTgId(tgUserId));
    },
    getUserById(id) {
      return toPublicUser(getUserById(id));
    },
    listApiKeyPreviewsByTelegramId(tgUserId) {
      return getKeysByUser(tgUserId).map(toPublicApiKeyPreview);
    },
    getEffectiveLimits(userId, apiKeyId) {
      return getEffectiveLimits(normalizeDbId(userId, "userId"), normalizeDbId(apiKeyId, "apiKeyId"));
    },
    getDailyUsage(userId, apiKeyId = null) {
      return getDailyUsage(normalizeDbId(userId, "userId"), normalizeOptionalDbId(apiKeyId, "apiKeyId"));
    },
    getMonthlyUsage(userId, apiKeyId = null) {
      return getMonthlyUsage(normalizeDbId(userId, "userId"), normalizeOptionalDbId(apiKeyId, "apiKeyId"));
    },
    checkModelAllowed(userId, apiKeyId, modelName, isAdmin = false) {
      return checkModelAllowed(normalizeDbId(userId, "userId"), normalizeDbId(apiKeyId, "apiKeyId"), modelName, isAdmin);
    },
    getAllowedModels(userId, apiKeyId, allModels, isAdmin = false) {
      return getAllowedModels(normalizeDbId(userId, "userId"), normalizeDbId(apiKeyId, "apiKeyId"), allModels, isAdmin);
    },
  });
}

/** Builds the full per-plugin `context.services` facade. */
export function createPluginServices(pluginId: string, logger: PluginLogger): PluginServices {
  validateName("plugin id", pluginId);
  const services: PluginServices = freezePublic({
    auth: createAuthService(),
    storage: createStorageService(pluginId),
    events: createEventsService(pluginId, logger),
    scheduler: createSchedulerService(pluginId, logger),
    providers: createProvidersService(),
    db: createDbService(),
  });
  return services;
}

/** Releases a plugin's timers/event listeners, or (with no `pluginId`) resets all plugin state — used at shutdown and by tests. */
export function cleanupPluginServices(pluginId?: string): void {
  if (pluginId) {
    pluginTimerRegistry.clearAllForPlugin(pluginId);
    pluginEventBus.removeAllForPlugin(pluginId);
    return;
  }
  pluginTimerRegistry.clearAll();
  pluginEventBus.clear();
}
