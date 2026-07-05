/**
 * In-memory pub/sub event bus backing `context.services.events`.
 *
 * This module has no admin-facing error messages of its own —
 * `eventName`/`handler` validation stays in services.ts (the public
 * API surface), close to the rest of the plugin-author contract. See
 * manager.ts's header for the full English/Chinese message convention.
 */

import type { PluginLogger } from "./types.js";

export type PluginEventHandler<T = unknown> = (payload: T) => unknown | Promise<unknown>;
export type PluginUnsubscribe = () => void;

export type PluginEventListener = {
  pluginId: string;
  handler: PluginEventHandler;
  once: boolean;
  logger: PluginLogger;
};

/** Per-event-name listener registry shared by all plugins. */
export class PluginEventBus {
  private readonly listeners = new Map<string, PluginEventListener[]>();

  /** Registers `listener` under `eventName`; returns an unsubscribe function. */
  addListener(eventName: string, listener: PluginEventListener): PluginUnsubscribe {
    const existing = this.listeners.get(eventName) ?? [];
    existing.push(listener);
    this.listeners.set(eventName, existing);
    return () => this.removeListener(eventName, listener);
  }

  removeListener(eventName: string, listener: PluginEventListener): void {
    const existing = this.listeners.get(eventName);
    if (!existing) return;
    const next = existing.filter((item) => item !== listener);
    if (next.length === 0) this.listeners.delete(eventName);
    else this.listeners.set(eventName, next);
  }

  /** Invokes every listener for `eventName` in order; per-listener errors are logged, not thrown. */
  async emit(eventName: string, payload: unknown): Promise<void> {
    const listeners = [...(this.listeners.get(eventName) ?? [])];
    for (const listener of listeners) {
      try {
        await listener.handler(payload);
      } catch (err) {
        listener.logger.error(`event handler failed: ${eventName}`, err);
      } finally {
        if (listener.once) this.removeListener(eventName, listener);
      }
    }
  }

  listenerCount(eventName: string): number {
    return this.listeners.get(eventName)?.length ?? 0;
  }

  /** Removes every listener registered by `pluginId`, across all event names. */
  removeAllForPlugin(pluginId: string): void {
    for (const [eventName, listeners] of this.listeners.entries()) {
      const next = listeners.filter((listener) => listener.pluginId !== pluginId);
      if (next.length === 0) this.listeners.delete(eventName);
      else this.listeners.set(eventName, next);
    }
  }

  /** Removes every listener for every plugin (full reset, used by tests). */
  clear(): void {
    this.listeners.clear();
  }
}

/** Singleton event bus shared by all plugins' `context.services.events`. */
export const pluginEventBus = new PluginEventBus();
