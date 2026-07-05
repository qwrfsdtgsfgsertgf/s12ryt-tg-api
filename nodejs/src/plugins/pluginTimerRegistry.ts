/**
 * Per-plugin timer bookkeeping backing `context.services.scheduler`.
 *
 * Timer-delay validation lives here (English messages — part of the
 * plugin-author services API contract; see manager.ts's header for
 * the full English/Chinese message convention). Several exact
 * substrings (`must be at least`, `exceeds the maximum timer delay`)
 * are asserted on by nodejs/tests/pluginServices.test.ts — do not
 * reword them.
 */

import type { PluginLogger } from "./types.js";

const MIN_TIMER_MS = 1000;
const MAX_TIMER_MS = 2_147_483_647;

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;
type TimerRecord = { handle: TimerHandle; interval: boolean };

/** Throws (English, plugin-author contract) if `value` isn't a valid timer delay. */
function normalizeTimerMs(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  const integer = Math.floor(value);
  if (integer < MIN_TIMER_MS) throw new Error(`${label} must be at least ${MIN_TIMER_MS}ms`);
  if (integer > MAX_TIMER_MS) throw new Error(`${label} exceeds the maximum timer delay`);
  return integer;
}

/** Per-plugin `setTimeout`/`setInterval` handle registry shared by all plugins. */
export class PluginTimerRegistry {
  private readonly timersByPlugin = new Map<string, Map<string, TimerRecord>>();
  private nextTimerId = 0;

  private getTimerMap(pluginId: string): Map<string, TimerRecord> {
    let timers = this.timersByPlugin.get(pluginId);
    if (!timers) {
      timers = new Map();
      this.timersByPlugin.set(pluginId, timers);
    }
    return timers;
  }

  setTimeout(pluginId: string, handler: () => unknown | Promise<unknown>, delayMs: number, logger: PluginLogger): string {
    const normalizedDelay = normalizeTimerMs(delayMs, "delayMs");
    const timerId = `${pluginId}:${++this.nextTimerId}`;
    const handle = globalThis.setTimeout(async () => {
      this.getTimerMap(pluginId).delete(timerId);
      try {
        await handler();
      } catch (err) {
        logger.error(`scheduled timeout failed: ${timerId}`, err);
      }
    }, normalizedDelay);
    this.getTimerMap(pluginId).set(timerId, { handle, interval: false });
    return timerId;
  }

  setInterval(pluginId: string, handler: () => unknown | Promise<unknown>, intervalMs: number, logger: PluginLogger): string {
    const normalizedInterval = normalizeTimerMs(intervalMs, "intervalMs");
    const timerId = `${pluginId}:${++this.nextTimerId}`;
    const handle = globalThis.setInterval(async () => {
      try {
        await handler();
      } catch (err) {
        logger.error(`scheduled interval failed: ${timerId}`, err);
      }
    }, normalizedInterval);
    this.getTimerMap(pluginId).set(timerId, { handle, interval: true });
    return timerId;
  }

  clear(pluginId: string, timerId: string): boolean {
    const timers = this.getTimerMap(pluginId);
    const timer = timers.get(timerId);
    if (!timer) return false;
    if (timer.interval) globalThis.clearInterval(timer.handle);
    else globalThis.clearTimeout(timer.handle);
    timers.delete(timerId);
    return true;
  }

  /** Clears every timer/interval owned by `pluginId`. */
  clearAllForPlugin(pluginId: string): void {
    const timers = this.timersByPlugin.get(pluginId);
    if (!timers) return;
    for (const timer of timers.values()) {
      if (timer.interval) globalThis.clearInterval(timer.handle);
      else globalThis.clearTimeout(timer.handle);
    }
    timers.clear();
    this.timersByPlugin.delete(pluginId);
  }

  /** Clears every timer/interval for every plugin (full reset, used by tests). */
  clearAll(): void {
    for (const pluginId of [...this.timersByPlugin.keys()]) this.clearAllForPlugin(pluginId);
  }
}

/** Singleton timer registry shared by all plugins' `context.services.scheduler`. */
export const pluginTimerRegistry = new PluginTimerRegistry();
