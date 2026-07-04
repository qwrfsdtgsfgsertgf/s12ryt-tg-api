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
