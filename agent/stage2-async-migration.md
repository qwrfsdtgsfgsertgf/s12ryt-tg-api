# 階段 2 執行手冊：database.ts 全面異步化

> 本檔案是階段 2（database.ts + 14 個呼叫檔 + 測試異步化）的單一接手依據。
> 階段 0（driver 介面）與階段 1（SqliteDriver + factory + 30 tests）已完成且零回歸。
> 設計藍圖見 `agent/db-cloud-migration-design.md`。

## 已完成（零回歸，專案可正常 build/test）

- `nodejs/src/db/driver/types.ts` — DbDriver 介面（query/run/insert/exec/batch/transaction/sync/close）
- `nodejs/src/db/driver/sqliteDriver.ts` — SqliteDriver + `getRawDatabase()`（供 backup shadow DB 用）
- `nodejs/src/db/driver/factory.ts` — createDriver（PG/MySQL throw 佔位，階段 3/4）
- `nodejs/src/db/dialect.ts` — NOW 常數（sqlite/postgres/mysql）
- `nodejs/tests/sqliteDriver.test.ts`（23 tests）+ `nodejs/tests/driverFactory.test.ts`（7 tests）全綠
- LSP 0 errors；`npm test` 原 409 tests 不受影響

## database.ts 完整原文位置

`nodejs/src/db/database.ts`（2430 行）。本 session 已逐段讀取 L1-900 精確原文。
- L1-68：import + 全域（db/dbPath）+ getDb + initDbAsync
- L69-385：createTables（11 表 DDL + migrations，SQLite 專屬）
- L386-483：auto-save/closeDb + helper（queryAll/queryOne/runSql/runSqlAndSave）
- L485-684：provider cache（CachedProvider/rebuildProviderCache/lookupModelCached/invalidateProviderCache[用 nextTick]/onProviderCacheRebuild）+ model mappings
- L690-826：apiKeyCache（LRU 256）+ usage write queue（5s flush/max 100）
- L828-...：providers/users/apiKeys/usage/settings/prices/coding/restrictions/groups/limits/quota/backup CRUD

## 改造規則（套用到所有 export function）

1. **所有 `export function` → `export async function`**（回傳值變 Promise）
2. **內部 helper 改 async + 用 driver**：
   - `queryAll(sql, params)` → `async function queryAll(...)`：`return (await drv().query<Record<string,SqlValue>>(sql, params as SqlParam[])).rows`
   - `queryOne` → `async`：`return (await queryAll(...))[0]`
   - `runSql(sql, params)` → `async`：`await drv().run(sql, params as SqlParam[])`（driver 內部標 dirty；不需手動設 dirty）
   - `runSqlAndSave(sql, params)` → `async`：`await drv().run(...); await drv().sync()`（sync = SQLite saveDb）
3. **`drv()` helper**（新增）：`function drv(): DbDriver { if(!driver) throw new Error("Database not initialized"); return driver }`
4. **`datetime('now')` 字面值 → `${NOW[driver!.dialect]}`**（~15 處：createTables DDL DEFAULT、updateProvider、upsertModelPrice、setSetting 等）
5. **`db.exec(sql)` 查 settings 版號（migration）→ `await driver.query("SELECT value FROM settings WHERE key=?", [k])`**（exec 回傳格式已被 driver 抽象）
6. **`db.run(sql, params)` 直接呼叫（upsertModelMapping/deleteModelMapping/replaceModelMappings）→ `await driver.run(...)` + `await driver.sync()` + `await invalidateProviderCache()`**
7. **`saveDb()` 呼叫 → `await driver.sync()`**

## 關鍵決策（已定案）

### driver 是 db 唯一擁有者
- 全域新增 `let driver: DbDriver | null = null`；保留 `let db: SqlJsDatabase | null`（僅 backup shadow 邏輯用，從 `SqliteDriver.getRawDatabase()` 取得）
- `initDbAsync(path, databaseUrl?)`：`driver = await createDriver({sqlitePath: path, databaseUrl})`；`if (driver.dialect==='sqlite') { db = (driver as SqliteDriver).getRawDatabase(); createTables(db); }`；`await rebuildProviderCache()`；`startUsageFlushTimer()`（auto-save 由 SqliteDriver 內部管理，移除 setupAutoSave）

### createTables 保持同步、操作 raw SqlJsDatabase
- 它是 SQLite 專屬 schema（DDL + migration），`createTables(db: SqlJsDatabase): void` 不變
- 雲端 schema 由階段 3/4 另寫（PG/MySQL DDL + schema_migrations）
- init 時從 SqliteDriver 取 raw db 傳入

### cache 同步策略（hot path 不阻塞）
- `lookupModelCached` / `getAllCachedModelNames` / `lookupApiKeyCached` / `getCachedEffectiveLimits`：**保持同步，只讀 cache**
- `rebuildProviderCache` → **async**（init 與寫入後顯式 `await`）
- `invalidateProviderCache`：保持同步（清 cache + 標記），但 nextTick 重建改為 **fire-and-forget** `void rebuildProviderCache().catch(...)`（不阻塞呼叫者）
- **cache miss 處理**：lookupApiKeyCached/getCachedEffectiveLimits 在 cache miss 時，回傳 null（讓上層處理為「未授權/無限制」）。啟動預載：init 後預先 `await rebuildProviderCache()` + 預載所有 api_keys 到 apiKeyCache（若要）。階段 2 可先接受 cache miss 回 null，進階預載留優化。
  - **重要**：auth middleware 若 cache miss 回 null 會擋掉合法 key。需評估：要嘛啟動預載所有 keys，要嘛 lookupApiKeyCached 變 async（auth middleware 變 async）。**建議：lookupApiKeyCached 變 async，讓 cache miss 查 DB**。這最正確。對應 auth middleware（middleware.ts）變 async。

### usage write queue
- `flushUsageQueue` → **async**（用 `await driver.batch([...])` 或 `await driver.transaction(async()=>{ for each: await driver.run(INSERT) })`）
- `enqueueUsage` / `recordUsage`：**保持同步**（只 push queue，不碰 DB）；滿 100 時 `void flushUsageQueue().catch(e=>console.error(...))`（fire-and-forget）
- `startUsageFlushTimer`：timer callback 改 `void flushUsageQueue().catch(...)`
- `closeDb` → **async**：`await flushUsageQueue()`；clear timers；`await driver.close()`；db=null

### backup/restore（階段 2 SQLite-only，雲端留階段 3/4）
- `exportDatabase` → **async**：`await flushUsageQueue()`；逐表 `await queryAll` → toJsonValue
- `createRestoreShadowDb`：保留用 raw SqlJsDatabase（`new (db!.constructor)()` 或 `await initSqlJs()` 建空），createTables(shadow)
- `validateBackupAgainstSchema`：shadow DB preflight，操作 raw db（同步 DB 呼叫）
- `importDatabase` → **async**：preflight + live DB 匯入用 `await driver.transaction(async()=>{ DELETE+INSERT 全表 })`；完後 `await rebuildProviderCache()` + clearProviderKeyState + `await driver.sync()`
- `getTableColumns`：PRAGMA table_info（SQLite 專屬，保留；雲端用 information_schema）

## 方言分歧點（SQLite→PG/MySQL，階段 3/4 處理，階段 2 先用 NOW 常數）
- `datetime('now')` → NOW[dialect]
- `date(u.created_at)=date('now')`（getPeriodUsage）→ 階段 2 暫保留 SQLite 語法（quota 查詢），雲端版階段 3/4 改 dialect 函數
- `PRAGMA`、`sqlite_sequence`、shadow DB → SQLite 專屬

## 14 個呼叫檔案（database.ts 變 async 後必須同步改）

用 `tsc --noEmit` 抓所有錯誤，逐檔：呼叫點加 `await`、所屬函數加 `async`。
- `nodejs/src/api/`: usageTracker, middleware, rateLimiter, quotaChecker, server
- `nodejs/src/bot/`: filters, webHandlers, userHandlers, limitHandlers, backupHandlers, adminHandlers
- `nodejs/src/web/`: routes, auth
- `nodejs/src/plugins/`: services

## 驗證策略
1. `npx tsc --noEmit` 零錯（會報所有缺 await 處，逐個修）
2. `npx vitest run` 原 409 + 新 30 = 439 tests 全綠（database.test.ts 1459 行也要 async 化）
3. database.test.ts：所有 `initDbAsync` 已是 async；但 CRUD 呼叫（addProvider 等）現在回傳 Promise，每個測試體內加 await

## git 安全網
database.ts 為 git tracked 未改原檔。若 write 的 async 版有嚴重問題：`git checkout -- nodejs/src/db/database.ts` 還原。

## 進度追蹤
- [x] 讀完 database.ts L901-2430 原文
- [x] write database.ts async 版（套用所有改造規則）
- [x] tsc 報錯 → 改 14 個呼叫檔（實際含 web/auth.ts + web/routes.ts = 16 檔）
- [x] 測試 async 化（database.test.ts + auth/quotaChecker/rateLimiter/pluginServices/web_routes = 6 檔）
- [x] tsc 零錯 + vitest 全綠（439 tests 全過，20 test files）

> **✅ 階段 2 已完成（2026-07-10）。** 所有 db 函式 async 化、14+ 呼叫檔對齊、6 個測試檔同步更新。
> tsc --noEmit 零錯；vitest run 439 tests 全綠（原 409 + 階段 0/1 新 30）。
> 已知後續：① plugin-example 需適配 PluginDbService 介面 Promise 化（breaking change）；
> ② pluginServices.test teardown ENOENT 雜音（test 品質，非功能 bug）。

### 實際改造的檔案清單
**核心**：`src/db/database.ts`（async 重寫）
**middleware**：`api/middleware.ts`、`api/rateLimiter.ts`、`api/quotaChecker.ts`、`api/server.ts`
**bot handlers**：`bot/filters.ts`、`bot/handlers/adminHandlers.ts`、`bot/handlers/backupHandlers.ts`、`bot/handlers/limitHandlers.ts`、`bot/handlers/userHandlers.ts`、`bot/handlers/webHandlers.ts`
**web**：`web/auth.ts`、`web/routes.ts`
**plugins**：`plugins/services.ts`（PluginDbService/PluginProvidersService/PluginAuthService 介面 Promise 化）
**測試**：`tests/database.test.ts`、`tests/auth.test.ts`、`tests/quotaChecker.test.ts`、`tests/rateLimiter.test.ts`、`tests/pluginServices.test.ts`、`tests/web_routes.test.ts`
