# Node.js 插件範例

這個資料夾是一個可直接啟用的 Node.js-only 插件範例，展示 `s12ryt-tg-api` 的插件生命週期、Express 路由與 grammY Bot 指令接入方式。

## 相關倉庫

- 主專案：[`s12ryt/s12ryt-tg-api`](https://github.com/s12ryt/s12ryt-tg-api)
- 獨立插件範例：[`s12ryt/s12ryt-nodejs-plugin-example`](https://github.com/s12ryt/s12ryt-nodejs-plugin-example)

這個倉庫保存可獨立發布與安裝的插件範例；主專案 README 也會連回此範例倉庫。

## 檔案結構

```text
./
├── dist/index.js      # 可被主程式直接載入的 ESM 插件
├── src/index.ts       # TypeScript 撰寫版本，示範如何使用核心型別
├── package.json       # 範例插件套件資訊
├── plugin.json        # 插件描述檔，供人工或工具讀取
└── README.md          # 本說明文件
```

## 啟用方式（建議：Web Console）

管理員登入 Web Console 後進入「插件管理」，可以用兩種方式安裝：

1. 匯入本機檔案：選擇 `dist/index.js`，按「安裝檔案」。
2. 從 GitHub 安裝：貼上 GitHub repo、tree、blob 或 raw 連結。若貼 repo/tree 連結，系統會讀取 `plugin.json` 的 `main` 欄位取得入口檔。

Web 安裝會把插件保存到 Node.js 的 `data/plugins/`，並寫入 manifest；後續重啟會自動載入，不需要再手動改 `.env`。

## 啟用方式（進階備援：環境變數）

若需要開機時直接載入固定路徑，也可以從 `nodejs/` 目錄啟動服務時，將插件入口加入 `NODEJS_PLUGIN_PATHS`：

```env
NODEJS_PLUGIN_PATHS=../plugin-example/dist/index.js
```

`NODEJS_PLUGIN_PATHS` 可以指向存在的 `.js` / `.mjs` 入口檔，也可以指向包含 `plugin.json` 的插件目錄；目錄模式會依序尋找 `plugin.json` 的 `main`、`package.json` 的 `module` / `main`、`index.mjs`、`index.js`。路徑不存在或不是可載入入口時，主程式會略過該項並印出警告。

也可以用逗號或分號載入多個插件：

```env
NODEJS_PLUGIN_PATHS=../plugin-example/dist/index.js;../another-plugin/dist/index.js
```

未設定 `NODEJS_PLUGIN_PATHS` 時，主程式仍會載入 Web Console 安裝過的插件；如果沒有任何已安裝插件，既有功能不受影響。

## 範例功能

啟用後會增加以下 API 路由。這些路由掛在核心 API middleware 後面，因此會沿用既有的 API Key 認證、速率限制與配額檢查。

| 方法 | 路徑 | 說明 |
|------|------|------|
| `GET` | `/plugins/nodejs-example/status` | 查看插件狀態、版本、啟動時間與範例路由 |
| `GET` | `/plugins/nodejs-example/me` | 示範 `context.services.auth`、`services.db` 與 `services.providers` |
| `POST` | `/plugins/nodejs-example/echo` | 回傳請求 body，示範如何讀取 Express request |

範例請求：

```bash
curl http://localhost:8000/plugins/nodejs-example/status \
  -H "Authorization: Bearer sk-s12ryt-your-key-here"
```

```bash
curl http://localhost:8000/plugins/nodejs-example/me \
  -H "Authorization: Bearer sk-s12ryt-your-key-here"
```

```bash
curl http://localhost:8000/plugins/nodejs-example/echo \
  -H "Authorization: Bearer sk-s12ryt-your-key-here" \
  -H "Content-Type: application/json" \
  -d '{"message":"hello plugin"}'
```

## Bot 指令

插件會註冊 `/plugin_example` 指令，回覆插件名稱、版本與狀態 API 路徑。

實務插件如果涉及管理操作，應在 handler 內自行檢查使用者身分或限制可用範圍。核心系統只負責把插件命令接入 grammY middleware 鏈，不會替插件判斷業務權限。

## 插件介面

每個插件預設匯出一個物件：

```ts
import type { NodeJsPlugin } from "../../nodejs/src/plugins/types.js";

const plugin: NodeJsPlugin = {
  name: "nodejs-example",
  version: "1.0.0",
  setup(context) {
    context.router.get("/status", (_req, res) => res.json({ ok: true }));
    context.registerBotCommand({
      command: "plugin_example",
      description: "Node.js 插件範例",
      handler: (ctx) => ctx.reply("plugin ok"),
    });
  },
  onStart(context) {
    context.logger.info("started");
  },
  onStop(context) {
    context.logger.info("stopped");
  },
};

export default plugin;
```

`context.router` 會自動掛到 `/plugins/<plugin-id>`，其中 `<plugin-id>` 由插件名稱標準化而來。例如 `nodejs-example` 的狀態路由就是 `/plugins/nodejs-example/status`。

`context.services` 提供插件穩定內部接口，常用能力包含：

- `services.auth`：檢查 Telegram admin / trusted user，或讀取 Express request 上的 API Key 認證資訊。
- `services.storage`：插件專屬 JSON KV 儲存，key 使用受限字元，單筆值上限 256KB。
- `services.events`：程序內事件 bus，支援訂閱、一次性訂閱、發布與取消訂閱。
- `services.scheduler`：受控 timeout / interval，插件停止時由核心集中清理。
- `services.providers`：只讀 provider、model、price、mapping 查詢；不回傳 provider API Key 或 base URL。
- `services.db`：只讀用戶、限制、用量與模型權限查詢；API Key 只回傳末 12 碼預覽。

範例：

```ts
setup(context) {
  context.router.get("/me", (req, res) => {
    const auth = context.services.auth.requireRequestAuth(req);
    const user = context.services.db.getUserByTelegramId(auth.tgUserId);
    res.json({ user, models: context.services.providers.listModels() });
  });

  context.services.storage.set("lastSetupAt", new Date().toISOString());
}
```

## 安全注意事項

- 插件只在 Node.js 版本中載入，不依賴已停止維護的 Python 版本。
- 插件可由 Web Console 管理員匯入檔案或 GitHub 連結；`NODEJS_PLUGIN_PATHS` 僅作為進階手動載入方式。
- 插件檔案會在主程式程序內執行，請只載入可信任程式碼。
- Web 安裝目前限制 `.js` / `.mjs` 入口檔，大小上限 1MB。
- 插件路由預設沿用 API Key 認證、rate limit 與 quota middleware。
- 插件 Bot 指令的業務權限需要插件自行檢查。
- `context.services.providers` 和 `context.services.db` 會遮蔽 API Key、provider base URL 等敏感資料；不要改用核心內部 DB 函式繞過這層限制。
- `context.services.storage` 資料目前不會進入主程式 `/backup` JSON，若插件需要備份請自行提供匯出流程。
- 不要在插件回應中輸出 API Key、Bot Token、資料庫路徑或其他敏感設定。

## 開發建議

- 將插件名稱視為公開路由的一部分，發布後不要隨意改名。
- 在 `setup()` 中只做路由與指令註冊，長時間任務放到 `onStart()`。
- 在 `onStop()` 清理計時器、連線、檔案 handle。
- 避免直接 import 核心內部模組；優先使用 `PluginContext` 暴露的穩定能力。
- 優先使用 `context.services.scheduler` 建立計時器，讓核心能在插件停止時清理資源。
