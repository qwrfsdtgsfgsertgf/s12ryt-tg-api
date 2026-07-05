/**
 * Public barrel export for the Node.js plugin system.
 *
 * This is the only module external code (nodejs/src/index.ts,
 * nodejs/src/api/server.ts, nodejs/src/web/routes.ts, and any
 * third-party plugin) should import from. Internal modules
 * (pluginRegistry.ts, pluginNaming.ts, pluginPathResolver.ts,
 * pluginManifest.ts, pluginEventBus.ts, pluginTimerRegistry.ts) are
 * implementation details of manager.ts / services.ts and are
 * intentionally not re-exported here.
 *
 * - types.ts: the plugin author's type contract (`PluginContext`, `NodeJsPlugin`, etc.)
 * - manager.ts: plugin discovery/lifecycle orchestration
 * - services.ts: the `context.services` runtime facade
 */
export type {
  LoadedNodeJsPlugin,
  NodeJsPlugin,
  NodeJsPluginBot,
  NodeJsPluginContext,
  PluginContext,
  PluginLogger,
  RegisterBotCommandOptions,
} from "./types.js";

export {
  bindPluginApp,
  getPluginBotCommands,
  getPluginRootRouter,
  initializeNodeJsPlugins,
  installNodeJsPluginFromContent,
  listNodeJsPlugins,
  loadNodeJsPlugins,
  shutdownNodeJsPlugins,
  startNodeJsPlugins,
} from "./manager.js";

export type {
  InstalledPluginRecord,
  PluginInstallInput,
  PluginInstallKind,
} from "./manager.js";

export type {
  PluginAuthService,
  PluginDbService,
  PluginEventsService,
  PluginEventHandler,
  PluginProvidersService,
  PluginSchedulerService,
  PluginServices,
  PluginStorageService,
  PluginUnsubscribe,
  PublicApiKeyPreview,
  PublicModelMapping,
  PublicModelPrice,
  PublicProvider,
  PublicProviderLookup,
  PublicUser,
} from "./services.js";
