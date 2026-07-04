/**
 * Unit tests for src/plugins/services.ts
 *
 * Strategy:
 * - Use a fresh temporary sql.js database for every test.
 * - Exercise the public plugin service facade only.
 * - Assert that sensitive DB fields are not exposed through provider/API key helpers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { Request } from "express";

import { config } from "../src/config.js";
import {
  addApiKey,
  addProvider,
  addUser,
  closeDb,
  initDbAsync,
  rebuildProviderCache,
} from "../src/db/database.js";
import { cleanupPluginServices, createPluginServices } from "../src/plugins/services.js";
import type { PluginLogger } from "../src/plugins/types.js";

let tmpDir: string;

function makeTempDbPath(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s12ryt-plugin-services-"));
  return path.join(tmpDir, "test.db");
}

function cleanupTempDir(): void {
  try {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors on Windows file handles.
  }
}

function createLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("Plugin services", () => {
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await initDbAsync(makeTempDbPath());
    cleanupPluginServices();
  });

  afterEach(() => {
    cleanupPluginServices();
    closeDb();
    cleanupTempDir();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stores JSON values in a plugin-scoped namespace", () => {
    const first = createPluginServices("alpha", createLogger());
    const second = createPluginServices("beta", createLogger());

    first.storage.set("settings.primary", { enabled: true, retries: 2 });
    second.storage.set("settings.primary", { enabled: false });

    expect(first.storage.get("settings.primary")).toEqual({ enabled: true, retries: 2 });
    expect(second.storage.get("settings.primary")).toEqual({ enabled: false });
    expect(first.storage.has("settings.primary")).toBe(true);
    expect(first.storage.keys()).toEqual(["settings.primary"]);
    expect(first.storage.delete("settings.primary")).toBe(true);
    expect(first.storage.delete("settings.primary")).toBe(false);
    expect(first.storage.get("settings.primary")).toBeNull();
    expect(second.storage.get("settings.primary")).toEqual({ enabled: false });

    second.storage.clear();
    expect(second.storage.keys()).toEqual([]);
  });

  it("rejects invalid storage keys and oversized values", () => {
    const services = createPluginServices("alpha", createLogger());
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(() => services.storage.set("bad key", true)).toThrow(/storage key/);
    expect(() => services.storage.set("big", "x".repeat(256 * 1024 + 1))).toThrow(/exceeds/);
    expect(() => services.storage.set("circular", circular)).toThrow();
  });

  it("exposes auth helpers without requiring grammY context objects", () => {
    const services = createPluginServices("alpha", createLogger());
    addUser(900001, "trusted");

    expect(services.auth.isAdminTelegramUser(config.ADMIN_ID)).toBe(true);
    expect(services.auth.isAdminTelegramUser(900001)).toBe(false);
    expect(services.auth.isTrustedTelegramUser(config.ADMIN_ID)).toBe(true);
    expect(services.auth.isTrustedTelegramUser(900001)).toBe(true);
    expect(services.auth.isTrustedTelegramUser(900002)).toBe(false);
    expect(() => services.auth.requireTrustedTelegramUser(900002)).toThrow(/Trusted/);

    const req = { auth: { userId: "1", apiKeyId: "2", tgUserId: 900001 } } as Request;
    expect(services.auth.getRequestAuth(req)).toEqual({ userId: "1", apiKeyId: "2", tgUserId: 900001 });
    expect(services.auth.requireRequestAuth(req).apiKeyId).toBe("2");
    expect(services.auth.getRequestAuth({} as Request)).toBeNull();
    expect(() => services.auth.requireRequestAuth({} as Request)).toThrow(/Authenticated/);
  });

  it("emits plugin events, supports once/unsubscribe, and contains listener errors", async () => {
    const logger = createLogger();
    const services = createPluginServices("alpha", logger);
    const received: unknown[] = [];

    services.events.on("usage.recorded", () => {
      throw new Error("listener failed");
    });
    const unsubscribe = services.events.on("usage.recorded", (payload) => received.push(payload));
    services.events.once("usage.recorded", (payload) => received.push({ once: payload }));

    expect(services.events.listenerCount("usage.recorded")).toBe(3);
    await services.events.emit("usage.recorded", { id: 1 });
    await services.events.emit("usage.recorded", { id: 2 });
    unsubscribe();
    await services.events.emit("usage.recorded", { id: 3 });

    expect(received).toEqual([{ id: 1 }, { once: { id: 1 } }, { id: 2 }]);
    expect(logger.error).toHaveBeenCalledTimes(3);
    expect(services.events.listenerCount("usage.recorded")).toBe(1);
  });

  it("cleans scheduled timers for a plugin", async () => {
    vi.useFakeTimers();
    const services = createPluginServices("alpha", createLogger());
    let count = 0;

    const intervalId = services.scheduler.setInterval(() => {
      count += 1;
    }, 1000);

    await vi.advanceTimersByTimeAsync(1000);
    expect(count).toBe(1);
    expect(services.scheduler.clear(intervalId)).toBe(true);
    expect(services.scheduler.clear(intervalId)).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(count).toBe(1);

    services.scheduler.setInterval(() => {
      count += 1;
    }, 1000);
    cleanupPluginServices("alpha");
    await vi.advanceTimersByTimeAsync(3000);
    expect(count).toBe(1);
    expect(() => services.scheduler.setTimeout(() => {}, 999)).toThrow(/at least/);
  });

  it("returns sanitized provider data without secrets or base URLs", () => {
    const services = createPluginServices("alpha", createLogger());
    addProvider({
      name: "Sensitive Provider",
      api_type: "openai_chat",
      base_url: "https://secret-provider.example/v1",
      api_key: "sk-provider-secret",
      user_agent: "plugin-test-agent",
      key_strategy: "round_robin",
      models: "gpt-test,gpt-extra",
      input_price: 1.25,
      output_price: 2.5,
    });
    rebuildProviderCache();

    const provider = services.providers.list()[0];
    const lookup = services.providers.lookupModel("gpt-test");

    expect(provider).toMatchObject({
      name: "Sensitive Provider",
      apiType: "openai_chat",
      models: ["gpt-test", "gpt-extra"],
      enabled: true,
      inputPrice: 1.25,
      outputPrice: 2.5,
    });
    expect(lookup).toMatchObject({
      providerName: "Sensitive Provider",
      apiType: "openai_chat",
      originalModel: "gpt-test",
      inputPrice: 1.25,
      outputPrice: 2.5,
    });
    expect(services.providers.listModels()).toEqual(["gpt-extra", "gpt-test"]);
    expect(JSON.stringify(provider)).not.toContain("sk-provider-secret");
    expect(JSON.stringify(provider)).not.toContain("secret-provider.example");
    expect(JSON.stringify(lookup)).not.toContain("sk-provider-secret");
    expect(JSON.stringify(lookup)).not.toContain("secret-provider.example");
  });

  it("returns read-only DB facade data with masked API key previews", () => {
    const services = createPluginServices("alpha", createLogger());
    addUser(900010, "api-user");
    const createdKey = addApiKey(900010).key;

    const user = services.db.getUserByTelegramId(900010);
    const previews = services.db.listApiKeyPreviewsByTelegramId(900010);

    expect(user).toMatchObject({ tgUserId: 900010, username: "api-user", isActive: true });
    expect(previews).toHaveLength(1);
    expect(previews[0]?.preview).toBe(`...${createdKey.slice(-12)}`);
    expect(JSON.stringify(previews)).not.toContain(createdKey);
    expect(services.db.getUserById(user!.id)).toEqual(user);
  });
});
