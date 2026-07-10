# 雲端資料庫遷移技術設計

> **狀態**：設計階段（未動程式碼）
> **策略**：策略 B — 可選後端（保留 SQLite，新增 PostgreSQL / MySQL）
> **建立日期**：2026-07-09
> **依據**：`nodejs/src/db/database.ts`（2430 行，~90 export 函數，11 張表）

---

## 1. 目標與範圍

### 目標
- 保留 SQLite 作為預設後端（維持單檔零依賴部署的易用性）。
- 新增 PostgreSQL 與 MySQL 兩種雲端後端，透過環境變數切換。
- 業務層（api / bot / web / plugins）的呼叫方式**維持不變**（除同步→異步必要的 `await`）。

### 不在範圍
- MongoDB（關聯式 schema 重建模成本不對等，已排除）。
- 多實例寫入共用同一 DB 的分散式鎖/競態處理（單實例連雲端 DB 即可；多實例為後續議題）。

### 成功標準
1. 不設 `DATABASE_URL` 時，行為與現況完全一致（SQLite 檔案）。
2. 設 `DATABASE_URL=postgres://...` 或 `mysql://...` 時，自動連雲端 DB。
3. 既有 16 個測試檔在 SQLite 後端全綠（無回歸）。
4. 新增 PG/MySQL 整合測試（至少針對核心 CRUD 與 backup）。

---

## 2. 現況分析

### 2.1 DB Layer 結構
| 靅向 | 現況 |
|------|------|
| 引擎 | `sql.js`（純 WASM SQLite），記憶體操作 + 30s auto-save 到檔案 |
| API 風格 | **同步**（`db.run` / `db.exec` / `d.prepare().all()` 皆同步） |
| 表 | 11 張：providers, users, api_keys, usage, settings, model_prices, coding_configs, model_restrictions, user_groups, model_mappings, plugin_storage |
| 抽象邊界 | `database.ts` 匯出 ~90 函數，業務層不寫 SQL |
| SQL | 全 raw，`?` placeholder，SQLite 專屬回傳格式 |

### 2.2 SQLite 特有語法（遷移障礙清單）
| 語法 | 出現處 | 用途 | 遷移處理 |
|------|--------|------|----------|
| `datetime('now')` | ~15 處（DEFAULT + UPDATE SET） | 時間戳 | 方言常數替換 |
| `PRAGMA foreign_keys` | init + backup | 外鍵開關 | PG/MySQL 預設開，移除 |
| `PRAGMA table_info` | getColumnNames | 取欄位名 | 改用 information_schema |
| `PRAGMA foreign_key_check` | backup 驗證 | 外鍵完整性 | 改用事務 + SET CONSTRAINTS |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | 所有表 | 自增主鍵 | PG: `SERIAL` / MySQL: `AUTO_INCREMENT` |
| `CHECK(... IN (...))` | providers.api_type, model_restrictions.mode | 約束 | 三家皆支援，語法通用 |
| `db.exec(){columns,values}` | 廣泛 | 結果集格式 | driver 統一回傳 `{rows}` |
| `BEGIN TRANSACTION`/`COMMIT` | usage flush | 交易 | 三家通用 |

### 2.3 呼叫影響面
14 個檔案 import `database.ts`：
- **api/**（5）：usageTracker, middleware, rateLimiter, quotaChecker, server
- **bot/**（6）：filters, webHandlers, userHandlers, limitHandlers, backupHandlers, adminHandlers
- **web/**（2）：routes, auth
- **plugins/**（1）：services

### 2.4 特殊機制（需重新設計）
- **usage write queue**：5s flush、max 100、單 transaction 批次。→ 保留，雲端 DB 更需要（降 RTT）。
- **provider routing cache / API key LRU / effective limits cache**：記憶體層。→ 完全保留，雲端 DB 更需要（降 round-trip）。
- **auto-save（30s）**：SQLite 檔案持久化。→ 雲端 DB 免（每筆即持久）；SQLite 保留。
- **backup/restore（shadow DB + foreign_key_check）**：SQLite 專屬。→ 雲端版重寫為事務式。

---

## 3. 核心挑戰

### 挑戰 1：同步 → 異步（最大工程）
`sql.js` 是同步 API，`pg`/`mysql2` 是 Promise-based。現有 ~90 個函數幾乎全同步。

**不可避**：雲端 DB 本質異步，無法包裝成同步。
**影響**：14 個呼叫檔案的所有呼叫點都要加 `await`，並把所屬函數改 `async`（漣漪至上層）。

### 挑戰 2：方言差異
DDL 與少數語法差異需處理（見 2.2 表）。

### 挑戰 3：PRAGMA 依賴
backup 驗證與欄位名查詢依賴 PRAGMA，雲端 DB 無對應，需替代方案。

---

## 4. 架構設計 — 兩條技術路線

### 路線 A：抽象 DbDriver + 保留 raw SQL（⭐ 推薦）

**核心想法**：設計一個低階 `DbDriver` 介面，統一三方言的執行介面；`database.ts` 內部保留現有 raw SQL，只把執行從 `db.run(sql)` 改為 `await driver.run(sql)`。

```
業務層 (api/bot/web/plugins)
        │  呼叫 ~90 個 async 函數（簽名不變，僅加 async/await）
        ▼
database.ts（重構為 async，內部用 driver 執行 raw SQL）
        │
        ▼
DbDriver 介面（統一 query/run/exec/batch/transaction）
   ├── SqliteDriver（包裝 sql.js，同步邏輯包為 Promise）
   ├── PostgresDriver（pg.Pool）
   └── MysqlDriver（mysql2/promise.Pool）
```

**DbDriver 介面草案**：
```typescript
export interface DbDriver {
  /** SELECT，回傳統一格式 { rows: Record<string, unknown>[] } */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** INSERT/UPDATE/DELETE，回傳 { changes, lastInsertRowid } */
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid?: number | bigint }>;
  /** 執行多語句（DDL），無回傳 */
  exec(sql: string): Promise<void>;
  /** 批次執行（usage queue 用），單一 transaction */
  batch(statements: { sql: string; params: unknown[] }[]): Promise<void>;
  /** 包裹 transaction */
  transaction<T>(fn: (tx: DbDriver) => Promise<T>): Promise<T>;
  /** 方言標識 */
  readonly dialect: "sqlite" | "postgres" | "mysql";
  close(): Promise<void>;
}
```

**placeholder 統一**：內部一律用 `?`，各 driver 在 `run`/`query` 內轉換（PG 轉 `$1,$2...`）。

**方言常數**：
```typescript
// dialectConstants.ts
export const NOW = { sqlite: "datetime('now')", postgres: "NOW()", mysql: "NOW()" };
// 用法：`... DEFAULT (${NOW[driver.dialect]})`
```

**優點**：
- ✅ 改動最集中（DB 執行層 + 異步化），保留現有 raw SQL 投資
- ✅ 不引入大型依賴與學習曲線
- ✅ 風險最低、可漸進
- ✅ 僅新增 `pg` / `mysql2` 兩個 driver 依賴（可選裝）

**缺點**：
- ❌ DDL 需寫三份（或用方言常數 + 條件分支）
- ❌ raw SQL 無編譯期型別推導（維持現況）
- ❌ backup/migration 機制需為雲端重寫

---

### 路線 B：Drizzle ORM 重寫

**核心想法**：用 Drizzle 的 query builder 重寫 `database.ts` 所有查詢；schema 用 `pgTable`/`mysqlTable`/`sqliteTable` 定義；migration 用 drizzle-kit 自動生成。

**事實**（已查證 Drizzle 文件）：schema 定義是 dialect-specific 的（`pgTable` ≠ `mysqlTable` ≠ `sqliteTable`），**需維護三份 schema**（結構相似但 API 不同）。可用工廠模式從「規格」生成三方言 schema 緩解。

**優點**：
- ✅ query 邏輯跨方言共用（`db.select().from(users)...`）
- ✅ migration 自動生成（drizzle-kit）
- ✅ 類型安全最強（query 結果有型別推導）
- ✅ 現代化、社群活躍

**缺點**：
- ❌ **重寫 ~90 個函數的 raw SQL → builder 語法**，工作量最大、轉換風險高
- ❌ schema 三份（雖可工廠化）
- ❌ 引入 drizzle-orm + drizzle-kit + 三方言 driver 依賴
- ❌ 學習曲線高
- ❌ 複雜查詢（effective limits 多層 JOIN/COALESCE）仍需 `sql.raw()` 逃生口

---

### 路線對照與推薦

| 維度 | 路線 A（抽象 driver） | 路線 B（Drizzle） |
|------|----------------------|-------------------|
| 現有代碼保留 | ✅ 保留 raw SQL | ❌ 全部重寫 |
| 工作量 | 中 | 大 |
| 風險 | 低（改動集中） | 中（重寫易引入 bug） |
| query 共用 | ✅ 大部分通用 | ✅ 完全共用 |
| DDL/schema | 三份（常數/條件） | 三份（工廠化） |
| migration | 手寫 | 自動 |
| 類型安全 | 中（raw SQL） | 最強 |
| 依賴增量 | pg + mysql2（可選裝） | drizzle-orm + drizzle-kit + drivers |
| 與專案契合度 | ✅ 高（穩定、漸進） | 中（現代化但震盪大） |

**推薦：路線 A**。理由：
1. 本專案已有大量 raw SQL 投資且穩定運行，重寫風險不對等。
2. 策略 B 的核心價值是「保留 SQLite 易用性 + 進階可上雲」，路線 A 用最小改動達成。
3. 同步→異步是無論如何都要做的，路線 A 把它獨立為單一遷移軸，可控。
4. 業務層函數簽名不變，只有 `async/await` 差異，影響面明確。

**若未來追求最強類型安全與自動 migration**，可在路線 A 穩定後，漸進遷移到 Drizzle（兩者可共存過渡期）。

---

## 5. 環境變數與分流

### 新增環境變數
```env
# 三選一（優先序：DATABASE_URL > DATABASE_TYPE > DATABASE_PATH）
DATABASE_URL=postgres://user:pass@host:5432/dbname   # 雲端（自動偵測方言）
DATABASE_URL=mysql://user:pass@host:3306/dbname

DATABASE_TYPE=sqlite|postgres|mysql   # 顯式指定（搭配 DATABASE_URL）
DATABASE_PATH=./data/bot.db           # 既有，僅 SQLite 用
```

### 分流邏輯（`createDriver()`）
```
1. 有 DATABASE_URL
   ├─ scheme 是 postgres/postgresql → PostgresDriver
   ├─ scheme 是 mysql/mariadb       → MysqlDriver
   └─ 其他                          → 錯誤
2. 無 DATABASE_URL → SqliteDriver（用 DATABASE_PATH，維持現況）
```

### driver 依賴可選裝
`pg` 與 `mysql2` 設為 `optionalDependencies`，僅在對應 `DATABASE_URL` 出現時 dynamic import；未安裝則給出明確錯誤訊息（「請執行 npm install pg」）。SQLite 仍是預設零依賴體驗。

---

## 6. 方言對照表（實作用）

### 6.1 DDL 對照
| 項目 | SQLite | PostgreSQL | MySQL |
|------|--------|------------|-------|
| 自增主鍵 | `INTEGER PRIMARY KEY AUTOINCREMENT` | `SERIAL PRIMARY KEY` 或 `id INTEGER GENERATED ALWAYS AS IDENTITY` | `INT PRIMARY KEY AUTO_INCREMENT` |
| 時間預設 | `DEFAULT (datetime('now'))` | `DEFAULT NOW()` | `DEFAULT NOW()` |
| 時間型別 | `TEXT`（ISO 字串） | `TIMESTAMP` 或 `TEXT`（保持字串相容） | `DATETIME` 或 `TEXT` |
| 布林 | `INTEGER` 0/1 | `BOOLEAN` 或 `INTEGER` | `TINYINT(1)` 或 `INT` |
| 文字 | `TEXT` | `TEXT` | `TEXT` |
| JSON 欄位 | `TEXT`（存 JSON 字串） | `JSONB`（可查詢）或 `TEXT` | `JSON` 或 `TEXT` |
| CHECK | `CHECK(col IN (...))` | 同 | 同（MySQL 8.0+ 預設強制） |
| 外鍵 | `FOREIGN KEY ... ON DELETE CASCADE` | 同 | 同 |

**決策**：為最大化相容與降低轉換風險，**雲端 DB 也用 `TEXT` 存時間與 JSON**（與 SQLite 一致），不刻意用原生 `TIMESTAMP`/`JSONB`。犧牲一點雲端型別能力，換取「三方言查詢邏輯完全一致」。未來可針對 PG 優化為 JSONB。

### 6.2 查詢語法對照
| 項目 | SQLite | PostgreSQL | MySQL |
|------|--------|------------|-------|
| placeholder | `?` | `$1, $2` | `?` |
| 取最後插入 ID | `lastInsertRowid` | `RETURNING id` | `LAST_INSERT_ID()` |
| LIKE | 区分大小寫視 collation | 區分大小寫（需 `ILIKE` 不區分） | 視 collation |
| 字串串接 | `\|\|` | `\|\|` | `CONCAT()` |

**處理**：
- placeholder：driver 內部統一轉換（路線 A 介面已涵蓋）。
- lastInsertRowid：driver 的 `run()` 回傳統一；PG 用 `RETURNING id`，MySQL 用 `LAST_INSERT_ID()`，SQLite 用 `lastInsertRowid`。
- LIKE：現有查詢多為精確比對或 `=`，影響小；若有 `LIKE` 需逐案檢查。

---

## 7. 機制改造細節

### 7.1 同步 → 異步遷移策略（漸進）

**原則**：bottom-up，先底層後上層，每層用 CI 把關。

**步驟**：
1. **database.ts 內部全異步化**：所有 `export function` → `export async function`，內部 `db.run` → `await driver.run`。
2. **14 個呼叫檔案逐一加 `await`**：用 TypeScript 編譯器輔助（async 函數未 await 會報錯），逐檔修。
3. **記憶體 cache 維持同步**：cache hit 不需 await（直接回傳），只在 cache miss 時 await DB。`lookupApiKeyCached` 等仍可同步呼叫（內部 cache 同步，miss 時才異步填充——但這需重設計為「預載入」或「背景填充」）。

**cache 異步難點**：現有 `lookupApiKeyCached`、`lookupModelCached` 是同步的，用在 API hot path（每請求查）。若 DB 變異步，cache miss 會阻塞。解決方案：
- **啟動時預載**：`initDb` 後預先把所有 provider/model/api_key 載入 cache（這些表小）。
- **寫入時同步更新 cache**：`addProvider`/`addApiKey` 等寫入後立即更新記憶體 cache，不依賴重新查詢。
- 如此 hot path 可完全走 cache（同步），只有冷啟動或失效時走 DB（異步）。

### 7.2 usage write queue（保留並強化）
- 機制不變（5s flush、max 100、單 transaction）。
- driver 的 `batch()` 方法封裝批次插入；SQLite 用 `BEGIN/COMMIT`，PG/MySQL 用 `transaction()`。
- 雲端 DB 下，批次化對降 RTT 更關鍵，保留正確。

### 7.3 backup / restore 重設計
現有：shadow DB（記憶體）匯入 → `PRAGMA foreign_key_check` → 原子替換。

雲端版：
- **export**：不變（查所有表 → JSON）。
- **import**：用單一 transaction 包裹所有 INSERT；利用外鍵 `ON DELETE CASCADE` + 事務 rollback 保證完整性（取代 PRAGMA foreign_key_check）。
  - PG/MySQL：`BEGIN; TRUNCATE/DELETE; INSERT...; COMMIT;`（失敗自動 rollback）。
  - SQLite：沿用 shadow DB + PRAGMA（保留）。
- backup 格式（JSON）跨後端通用，可從 SQLite 匯出再匯入雲端 DB（遷移工具）。

### 7.4 migration 機制
現有：建 `_new` 表 → 複製 → 重新命名（SQLite 特有）。

雲端版：
- 改為標準 migration：版號表 `schema_migrations` + 依序執行 SQL 檔。
- 初始 migration = 現有 `createTables()` 的各方言版本。
- 三方言各維護一份 migration SQL（或用方言常數生成）。

### 7.5 plugin_storage
- 由 plugin services 建立，語法簡單（key-value 表）。
- 三方言通用，DDL 隨主 schema 一起處理。

---

## 8. 改動清單與影響範圍

### 新增檔案
| 檔案 | 用途 |
|------|------|
| `nodejs/src/db/driver/types.ts` | `DbDriver` 介面 |
| `nodejs/src/db/driver/sqliteDriver.ts` | SQLite driver（包裝 sql.js） |
| `nodejs/src/db/driver/postgresDriver.ts` | PG driver（dynamic import pg） |
| `nodejs/src/db/driver/mysqlDriver.ts` | MySQL driver（dynamic import mysql2） |
| `nodejs/src/db/driver/factory.ts` | `createDriver()` 分流 |
| `nodejs/src/db/dialect.ts` | 方言常數（NOW、placeholder 轉換等） |
| `nodejs/src/db/schema/` | 三方言 DDL（createTables 各版本） |

### 重構檔案
| 檔案 | 改動 |
|------|------|
| `nodejs/src/db/database.ts` | 全函數異步化 + 改用 driver 執行 + 方言常數替換 |
| `nodejs/src/index.ts` | `initDb` → `await initDb` |
| 14 個呼叫檔案 | 所有 DB 函數呼叫加 `await` + 所屬函數改 `async` |

### 測試新增
| 檔案 | 用途 |
|------|------|
| `tests/dbDriver.test.ts` | driver 介面契約測試（三方言同規格） |
| `tests/postgresIntegration.test.ts` | PG 整合測試（需 PG，CI 用 service container） |
| `tests/mysqlIntegration.test.ts` | MySQL 整合測試（需 MySQL，CI 用 service container） |

### 依賴增量
- `pg`（optionalDependencies）
- `mysql2`（optionalDependencies）
- 可選：`dotenv` 已有

---

## 9. 分階段實施計畫

> **✅ 全部階段已完成（2026-07-10）。** PG/MySQL 整合測試待 GitHub Actions CI（pg-test / mysql-test job）驗證連線。

### 階段 0：準備（0.5 天）
- [x] 確認技術選型（路線 A vs B，本設計建議 A）
- [x] 建立 `db/driver/` 目錄與介面
- [x] 設定 CI PG/MySQL service container

### 階段 1：抽象 driver 層（1-2 天）
- [x] 實作 `DbDriver` 介面
- [x] 實作 `SqliteDriver`（包裝現有 sql.js，同步邏輯包為 Promise，行為零變化）
- [x] `createDriver()`：無 DATABASE_URL 時回 SqliteDriver
- [x] **驗證**：SQLite 全測試通過（此時 database.ts 尚未異步化，driver 暫用同步包裝）

### 階段 2：database.ts 異步化（2-3 天）⭐ 最關鍵
- [x] 所有 export 函數 → async
- [x] 內部 `db.run/exec/prepare` → `await driver.run/query`
- [x] placeholder 統一（?），driver 內部轉換
- [x] datetime('now') → 方言常數
- [x] 14 個呼叫檔案加 await（用 tsc 逐檔抓錯）
- [x] cache 預載機制（啟動載入 provider/model/api_key）
- [x] **驗證**：tsc 零錯 + SQLite 全測試通過

### 階段 3：PostgreSQL 後端（1-2 天）
- [x] 實作 `PostgresDriver`（pg.Pool + placeholder 轉換 + RETURNING id）
- [x] PG 版 DDL（createTables postgres 版）
- [x] backup/restore PG 版（事務式）
- [x] migration 機制（schema_migrations）
- [x] **驗證**：PG 整合測試通過

### 隘段 4：MySQL 後端（1-2 天）
- [x] 實作 `MysqlDriver`（mysql2 Pool + LAST_INSERT_ID）
- [x] MySQL 版 DDL
- [x] backup/restore MySQL 版
- [x] **驗證**：MySQL 整合測試通過

### 階段 5：收尾（0.5-1 天）
- [x] 環境變數文件更新（README + .env.example）
- [x] Docker Compose 範例（加 PG/MySQL service 版本）
- [x] SQLite→雲端遷移工具（用 backup JSON 匯入）
- [x] 全測試 + build 驗證
- [x] 更新 agent 文件

**預估總工時**：6-10 天（取決於異步化漣漪複雜度與 cache 重設計）。

---

## 10. 風險評估與緩解

| 風險 | 嚴重度 | 緩解 |
|------|--------|------|
| 異步化漣漪超出預期（cache hot path） | 高 | 預載機制 + 啟動時驗證 cache 完整 |
| 方言 SQL 差異導致查詢結果不一致 | 中 | driver 契約測試（三方言同 input 同 output） |
| 時區差異（SQLite 本地 vs 雲端 UTC） | 中 | 統一存 UTC ISO 字串；驗證 usage 統計 |
| PG/MySQL 整合測試在 CI 不穩 | 中 | 用 service container + 啟動等待邏輯 |
| sql.js 移除 auto-save 後資料遺失 | 中 | SqliteDriver 仍保留 auto-save（雲端才免） |
| 可選依賴 dynamic import 在打包/Docker 失敗 | 中 | Docker image 預裝 pg/mysql2；README 說明 |
| backup JSON 跨後端匯入失敗（型別差異） | 中 | backup 統一為字串型別；整合測試驗證 |

---

## 11. 測試策略

### 11.1 SQLite 回歸（必過）
現有 16 測試檔全綠，作為「行為零變化」基線。

### 11.2 driver 契約測試
針對 `DbDriver` 介面寫一套規格測試（CRUD、transaction、batch、placeholder），三方言跑同一套——確保方言一致性。

### 11.3 雲端整合測試
- 用 CI service container 跑真實 PG/MySQL。
- 至少覆蓋：createTables、provider CRUD、user/key CRUD、usage 批次、backup export/import、effective limits 查詢。
- 用 `describe.skipIf(!process.env.PG_URL)` 模式（本機無 DB 時 skip，CI 才跑）。

### 11.4 資料遷移驗證
SQLite 建測試資料 → backup JSON → 匯入 PG/MySQL → 比對查詢結果一致。

---

## 12. 待決策點（需使用者確認）

1. **技術路線**：路線 A（抽象 driver + 保留 raw SQL，推薦）vs 路線 B（Drizzle 重寫）？
2. **時間型別**：雲端 DB 用 `TEXT`（相容優先，推薦）vs 原生 `TIMESTAMP`（型別能力優先）？
3. **JSON 欄位**：用 `TEXT`（推薦）vs PG 用 `JSONB`（可查詢但方言分歧）？
4. **MySQL 版本基線**：MySQL 8.0+（CHECK 強制，推薦）vs 支援 5.7（CHECK 忽略）？
5. **cache 預載策略**：啟動全載（推薦）vs 惰性載入？
6. **driver 依賴**：optionalDependencies（推薦，SQLite 零依賴）vs 永遠安裝？

---

## 附錄：driver 介面使用範例（路線 A）

```typescript
// 業務層呼叫（簽名不變，僅 async）
const provider = await getProviderById(1);
await addProvider({ name: "openai", ... });

// database.ts 內部
export async function getProviderById(id: number): Promise<Provider | undefined> {
  const { rows } = await driver.query<Provider>(
    "SELECT * FROM providers WHERE id = ?",
    [id]
  );
  return rows[0];
}

// driver 內部 placeholder 轉換（PG）
// 原始: SELECT * FROM providers WHERE id = ?
// PG 實際: SELECT * FROM providers WHERE id = $1
```
