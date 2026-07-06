# Deep Todos

## 2026-07-06 - 串流 token usage 注入與輸入 token 估算修復

- [x] **串流客戶端斷線資源洩漏修復**（commit `1c7cc83`）：`forwardStreamAndExtractUsage` 和 `extractUsageFromProviderStream`（server.ts）加上 `res?: Response` 參數 + `res.on('close', onClientClose)` 監聽；前者改用手動 `iterator = stream[Symbol.asyncIterator]()` + `while` 迴圈以便呼叫 `iterator.return()`，後者複用既有冪等的 `cancelProviderStream()`。5 個呼叫點全部傳入 `res`（chat/completions forward ~L810、responses 直通 forward ~L957、messages 直通 forward ~L1296、responses 轉換 extract ~L1124、messages 轉換 extract ~L1426）。provider 端 streaming generator 已有完整 `finally`（`requestTimeout.abort()` + `reader.cancel()` + `reader.releaseLock()`），無需改動。
- [x] **輸入 token 估算補全 — tools/functions**（commit `34919b3`）：`extractInputTextFromBody`（usageTracker.ts）纳入 `JSON.stringify(body.tools)` 與 `JSON.stringify(body.functions)`，解決含工具定義的請求 input token 嚴重低報。
- [x] **輸入 token 估算補全 — Anthropic 欄位**（commit `976e7ff`）：`extractInputTextFromBody` 處理 `body.system`（string 或 array）、`tool_result` content blocks、`tool_use` name+input blocks。
- [x] **Chat completions SSE usage 注入**（commit `6f66e5d`）：`forwardStreamAndExtractUsage` 攔截 `data: [DONE]`，provider 未返回 usage 時跑 fallback token 估算並注入合成 usage chunk。改用 SSE 行級 forwarding（decode→split→rejoin→encode）取代 raw byte 透傳，以便攔截終止事件。
- [x] **Anthropic messages SSE usage 注入**（commit `57056de`）：攔截 `event: message_stop` + 對應 data，注入合成 `message_delta`（帶 `input_tokens`/`output_tokens`）後再 forward `message_stop`。同時修復 messages 直通呼叫點（~L1340）原本漏傳 `res` 參數的問題。
- [x] **Responses + 轉換路徑 usage 注入**（commit `20f9af7`）：Responses 直通路徑攔截 `event: response.completed`，patch JSON 補 usage。轉換路徑（`extractUsageFromProviderStream`）將 fake chat-completions 格式 usage chunk 注入 passThrough stream，converter（streamResponsesApi/streamAnthropicApi）自動讀取並以各自格式發出，converter 程式碼零改動。
- [x] **新增 `full_request_integration.test.ts`**（commit `c30bebe`）：用真實 194KB 請求（110 個 tools）驗證，BPE=32,422 tokens、heuristic=35,560 tokens、tools 占輸入 85.4%；量化修復前後差異（舊估算 5,188 vs 新估算 35,560，漏報 85.4%）。
- [x] **CI 修復**（commit `5901f24`）：`full_request_integration.test.ts` 在 CI 因 vitest `describe.skipIf` 仍執行 factory 函數（用來收集 test 定義）導致 `readFileSync` 拋 ENOENT。用 `existsSync` 結果保護 factory 內檔案讀取，檔案不存在時 factory 為 no-op。
- [x] 驗證：本地 401 測試全通過（394 base + 7 integration），`tsc` build 通過。

## 2026-07-05 - 插件系統優雅化重構（拆分 manager.ts/services.ts 全域狀態）

- [x] 盤點 `nodejs/src/plugins/` 現況（`manager.ts` 430 行、`services.ts` 573 行皆含大量 module-level 可變全域狀態）與對外使用點（`nodejs/src/index.ts`、`nodejs/src/api/server.ts`、`nodejs/src/web/routes.ts`）。
- [x] 確認重構範圍：允許小幅調整 `PluginContext`/`services` 公開介面（需同步 `plugin-example/`），錯誤訊息維持「英文=插件作者契約/boot-time 診斷；繁體中文=管理員向 Web Console 操作結果」混合慣例（逐條核對後結論：現狀已大致正確，改為補 JSDoc 而非翻譯）。
- [x] 新增 `pluginNaming.ts`（ID/檔名淨化與驗證：`normalizePluginId`、`sanitizeFileStem`、`assertPluginFilename`、`assertPluginSize`）。
- [x] 新增 `pluginPathResolver.ts`（插件入口路徑解析：`resolvePluginPath`、`readEntryFromJson`、`resolvePluginEntryPath`，含測試依賴的英文 console.warn 訊息，字串逐字保留）。
- [x] 新增 `pluginManifest.ts`（manifest 讀寫：`getPluginDataDir`、`getManifestPath`、`readManifest`、`writeManifest` + 型別 `InstalledPluginRecord`/`PluginInstallKind`/`PluginInstallInput`）。
- [x] 新增 `pluginRegistry.ts`：封裝 `manager.ts` 原本的 module-level 可變狀態（loaded/installed plugins、per-plugin contexts、bot commands、app/bot 綁定、生命週期旗標）為 `PluginRegistry` class + singleton。
- [x] 重構 `manager.ts`：改用上述 4 個新模組 + `pluginRegistry`，9 個 export 函式簽名（`getPluginRootRouter`、`bindPluginApp`、`loadNodeJsPlugins`、`initializeNodeJsPlugins`、`startNodeJsPlugins`、`shutdownNodeJsPlugins`、`getPluginBotCommands`、`listNodeJsPlugins`、`installNodeJsPluginFromContent`）完全不變，`index.ts`/`server.ts`/`web/routes.ts` 均無需改動。
- [x] 新增 `pluginEventBus.ts`（`PluginEventBus` class 封裝事件監聽 Map）與 `pluginTimerRegistry.ts`（`PluginTimerRegistry` class 封裝計時器 Map），重構 `services.ts` 改用這兩個 singleton，並抽出 `freezePublic<T>()` 共用 helper 取代 5 處重複的 `toPublicX` + `Object.freeze` 樣板。
- [x] 為 `types.ts`（`PluginContext`/`NodeJsPlugin`/`NodeJsPluginContext` 等）與 `index.ts`（barrel export）補強 JSDoc，記錄語言慣例與型別用途/呼叫時機/錯誤處理契約，未變更任何欄位/簽名。
- [x] 確認 `plugin-example/` 不需修改（公開 API 完全未變，只新增註解，未重讀該目錄，信任先前完整分析）。
- [x] 驗證：`lsp_diagnostics`（`nodejs/src/plugins/` 10 個檔案 0 錯誤）、`npm run build`（tsc 成功）、`npm test`（16 個測試檔、362 個測試全通過，含 `pluginManager.test.ts`、`pluginServices.test.ts` 所有英文斷言字串/正則未破）。
- [x] 更新 `agent/deep_todos.md`、`agent/memory.md`、`agent/項目表.md`。

## 2026-07-05 - 全專案盤點與 agent 文件更新

- [x] 盤點 tracked file 清單；本環境沒有 `rg`，改用 `git ls-files`、glob 與 targeted read。
- [x] 閱讀根目錄文件與部署設定：`README.md`、`CHANGELOG.md`、`VERSION`、`Dockerfile`、`docker-compose.yml`、`.dockerignore`、`.gitignore`、`.node-version`、`.nvmrc`、GitHub Actions workflows、`scripts/vps.sh`。
- [x] 閱讀 Node.js 主線設定與啟動流程：`nodejs/package.json`、`tsconfig.json`、`vitest.config.ts`、`.env.example`、`.npmrc`、`start.js`、`scripts/with-memory.mjs`、`scripts/release.ts`。
- [x] 閱讀 Node.js 主要後端模組：`src/index.ts`、`config.ts`、`memory.ts`、`net.ts`、`tunnel.ts`、`updater.ts`、`db/database.ts`。
- [x] 閱讀 API proxy 層：`server.ts`、auth/rate/quota middleware、key selector、usage tracker、Responses/Anthropic conversion、thinking parser、provider adapters、API log store。
- [x] 閱讀 Bot/Web 管理層：user/admin/limit/update/web/backup handlers、model fetcher、Web auth/routes、前端 `index.html`/`app.js`/`style.css`。
- [x] 閱讀插件系統：`plugins/types.ts`、`services.ts`、`manager.ts`、`plugin-example/` package/manifest/src/dist/README。
- [x] 閱讀 Node.js 測試分佈：API、auth、config、database、plugin manager/services、providers、quota/rate、responses、security coding、thinking parser、updater、web routes、backup/Anthropic 相關測試。
- [x] 補讀 Python 停止維護區的 `requirements.txt`、`.env.example`、`main.py`、`pytest.ini`，僅記錄歷史狀態。
- [x] 刻意不讀任何真實 `.env` 檔，避免接觸 secret。
- [x] 更新 `agent/deep_todos.md`、`agent/項目表.md`、`agent/memory.md` 作為後續接手依據。

## 2026-07-05 - Docker Compose 範例

- [x] 新增根目錄 `docker-compose.yml` 範例，預設使用 `ghcr.io/s12ryt/s12ryt-tg-api:latest`。
- [x] Compose 範例使用 `BOT_TOKEN`、`ADMIN_ID` 等 `.env` 變數，並掛載 `./nodejs/data:/app/nodejs/data` 保留資料。
- [x] 在 README 補上 Docker Compose 使用方式。
- [x] 執行 `docker compose config` 與 `git diff --check` 驗證。

## 2026-07-05 - 插件路徑載入防呆

- [x] 追查 `ERR_MODULE_NOT_FOUND` 來源，確認是 `NODEJS_PLUGIN_PATHS` 指向不存在的 `/nodejs/plugin`。
- [x] 在插件 manager 匯入前加入路徑 preflight，缺路徑、非一般檔案與錯副檔名改為 concise skip warning。
- [x] 支援目錄型插件入口解析：`plugin.json` main、`package.json` module/main、`index.mjs`、`index.js`。
- [x] 補上 `pluginManager` 回歸測試，覆蓋缺路徑、錯副檔名與目錄入口載入。
- [x] 更新 `.env.example` 與插件範例 README，說明 `NODEJS_PLUGIN_PATHS` 合法入口格式。
- [x] 執行 LSP、`npm test -- pluginManager` 與 `npm run build` 驗證。

## 2026-07-05 - Linux VPS 一鍵部署腳本

- [x] 盤點 Node.js 啟動、build、Dockerfile、`.env.example` 與部署相關檔案。
- [x] 新增 `scripts/vps.sh`，支援安裝與更新、systemd 與 docker 兩種部署模式。
- [x] 腳本支援互動填寫 `.env` 或讀取目前 shell 環境變數。
- [x] systemd 模式自動準備 Node.js 22、build 專案、建立 service，並使用非 root service user 執行。
- [x] docker 模式自動準備 Docker、pull GHCR image、重建 container，並掛載 `nodejs/data`，不再 clone 倉庫或在 VPS 上 build。
- [x] 補強 docker/systemd 分支防呆：Docker 選項改為第一項、預設資料目錄改為 `/opt/s12ryt-tg-api-docker`、`sync_repo()` 加 systemd-only guard。
- [x] README 新增 VPS 一鍵部署入口與使用方式。
- [x] 完成 shell 語法、安全與文件驗證。

## 2026-07-05 - 根 README 閱讀性重整

- [x] 盤點根 README 現有章節、快速開始、API、Bot、Web、插件、更新備份與授權資訊。
- [x] 將 README 改為先導覽、快速開始、第一次設定，再提供 API 與管理細節的閱讀順序。
- [x] 收斂過長架構與專案結構段落，改用表格與短概覽提高掃讀效率。
- [x] 保留 Python 停止維護、plugin-example 位置、獨立插件倉庫、備份還原安全等重要資訊。
- [x] 檢查連結目標與 placeholder，確認沒有真實 token 或 secret。

## 2026-07-04 - PluginContext 穩定內部服務接口

- [x] 盤點插件 manager、types、DB/provider API 與測試慣例。
- [x] 新增 `context.services`，包含 auth、storage、events、scheduler、providers、db facade。
- [x] 將插件服務注入 `PluginContext`，並在插件 shutdown 時清理事件 listener 與 timer。
- [x] 補上 `pluginServices` 測試，覆蓋 storage namespace、auth、events、scheduler、provider sanitization 與 API key preview masking。
- [x] 將 services 使用範例落在 `plugin-example/` 的 `src/index.ts`、`dist/index.js`、`plugin.json` 與 README。
- [x] 執行完整 build 與回歸測試後收尾。

## 2026-07-04 - 發布 plugin-example 獨立倉庫

- [x] 盤點 `plugin-example/` 內容與主 README。
- [x] 建立 GitHub 倉庫 `s12ryt/s12ryt-nodejs-plugin-example`。
- [x] 推送 `plugin-example/` 的 README、package、plugin manifest、dist 與 src。
- [x] 更新主 README，加入獨立插件倉庫連結。
- [x] 更新插件 README，加入主倉庫與插件倉庫連結。
- [x] 執行驗證：`npm run check` 或等效語法檢查。

## 2026-07-04 - Python 停止維護標示

- [x] 將 `python/` 目錄改名為 `python(not-supported)/`。
- [x] 在根 README 最上方標示 Python 版本已停止維護。
- [x] 更新 README 中的快速開始、工程描述、專案結構與技術棧。
- [x] 更新插件範例 README 中對 Python 版本的描述。
- [x] 執行文件搜尋驗證，確認舊 `cd python` / `python/` 路徑未殘留於 Markdown 文件。
