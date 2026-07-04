import type { NodeJsPlugin } from "../../nodejs/src/plugins/types.js";

const startedAt = new Date();

function toSafeJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null));
}

const plugin: NodeJsPlugin = {
  name: "nodejs-example",
  version: "1.0.0",
  description: "Detailed Node.js-only plugin example for s12ryt-tg-api",

  setup(context) {
    context.logger.info("setup hook called");

    context.usePluginMiddleware((_req, res, next) => {
      res.setHeader("X-Plugin-Name", context.name);
      next();
    });

    context.router.get("/status", (_req, res) => {
      res.json({
        plugin: context.name,
        version: context.version,
        nodeOnly: true,
        startedAt: startedAt.toISOString(),
        uptimeSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
        routes: [
          "GET /plugins/nodejs-example/status",
          "POST /plugins/nodejs-example/echo",
        ],
        commands: ["/plugin_example"],
      });
    });

    context.router.post("/echo", (req, res) => {
      res.json({
        plugin: context.name,
        receivedAt: new Date().toISOString(),
        body: toSafeJson(req.body),
      });
    });

    context.registerBotCommand({
      command: "plugin_example",
      description: "Node.js 插件範例",
      async handler(ctx) {
        await ctx.reply(
          [
            "Node.js 插件範例已啟用。",
            `名稱：${context.name}`,
            `版本：${context.version}`,
            "API：GET /plugins/nodejs-example/status",
          ].join("\n")
        );
      },
    });
  },

  onStart(context) {
    context.logger.info("onStart hook called");
  },

  onStop(context) {
    context.logger.info("onStop hook called");
  },
};

export default plugin;
