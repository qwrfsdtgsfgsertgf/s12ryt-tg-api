/**
 * SQLite driver backed by sql.js (in-memory WASM SQLite persisted to a file).
 *
 * This driver wraps the synchronous sql.js API in async methods so it shares
 * the {@link DbDriver} contract with the cloud drivers. Because sql.js runs
 * entirely in memory, writes are buffered and flushed to disk on a 30s
 * auto-save timer (matching the historical `database.ts` behaviour) plus on
 * explicit {@link SqliteDriver.sync} / {@link SqliteDriver.close}.
 *
 * Responsibilities (engine layer only):
 *  - initSqlJs, load/create the .db file, PRAGMA foreign_keys = ON
 *  - dirty flag + periodic auto-save
 *  - SQL execution (query/run/insert/exec/batch/transaction)
 *
 * NOT handled here (kept in `database.ts` as business logic):
 *  - schema (CREATE TABLE), provider cache rebuild, usage flush timer.
 */

import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database as SqlJsDatabase, type SqlValue } from "sql.js";

import type {
  BatchStatement,
  DbDriver,
  DbDialect,
  DbRow,
  InsertResult,
  QueryResult,
  RunResult,
  SqlParam,
} from "./types.js";

/** Auto-save interval, matching the historical database.ts value. */
const AUTO_SAVE_INTERVAL_MS = 30_000;

/**
 * Convert a cross-dialect {@link SqlParam} into a sql.js-native {@link SqlValue}.
 *
 * - bigint is coerced to Number (sql.js has no native bigint support; ids in
 *   this project never exceed Number.MAX_SAFE_INTEGER in practice).
 * - boolean is stored as 0/1, consistent with the existing INTEGER columns.
 */
function toSqlValue(p: SqlParam): SqlValue {
  if (typeof p === "bigint") return Number(p);
  if (typeof p === "boolean") return p ? 1 : 0;
  return p; // string | number | null | Uint8Array
}

function toSqlValues(params?: SqlParam[]): SqlValue[] {
  return params ? params.map(toSqlValue) : [];
}

export class SqliteDriver implements DbDriver {
  readonly dialect: DbDialect = "sqlite";

  private db: SqlJsDatabase | null = null;
  private readonly dbPath: string;
  private dirty = false;
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /**
   * Create and initialise a driver for the given file path.
   * The parent directory is created if missing; an existing file is loaded,
   * otherwise a fresh in-memory database is created and later persisted.
   */
  static async create(dbPath: string): Promise<SqliteDriver> {
    const driver = new SqliteDriver(dbPath);
    await driver.init();
    return driver;
  }

  private async init(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const SQL = await initSqlJs();
    if (fs.existsSync(this.dbPath)) {
      this.db = new SQL.Database(fs.readFileSync(this.dbPath));
    } else {
      this.db = new SQL.Database();
    }

    this.db.run("PRAGMA foreign_keys = ON");

    this.saveTimer = setInterval(() => {
      if (this.dirty) {
        this.saveToDisk();
        this.dirty = false;
      }
    }, AUTO_SAVE_INTERVAL_MS);
  }

  /** Ensure the database is open and return it, or throw a contract error. */
  private d(): SqlJsDatabase {
    const current = this.db;
    if (!current) {
      throw new Error("SqliteDriver is not initialised or has been closed");
    }
    return current;
  }

  /**
   * Return the underlying sql.js database handle.
   *
   * INTERNAL: intended only for the SQLite-specific backup/restore shadow-DB
   * preflight logic in `database.ts` (which needs a raw handle to build an
   * in-memory copy and run `PRAGMA foreign_key_check`). Cloud drivers do not
   * expose anything equivalent; cloud backup uses a transaction-based flow.
   */
  getRawDatabase(): SqlJsDatabase {
    return this.d();
  }

  async query<T = DbRow>(sql: string, params?: SqlParam[]): Promise<QueryResult<T>> {
    const d = this.d();
    const stmt = d.prepare(sql);
    try {
      stmt.bind(toSqlValues(params));
      const rows: DbRow[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as DbRow);
      }
      return { rows: rows as T[] };
    } finally {
      stmt.free();
    }
  }

  async run(sql: string, params?: SqlParam[]): Promise<RunResult> {
    const d = this.d();
    d.run(sql, toSqlValues(params));
    const changes = d.getRowsModified();
    this.dirty = true;
    return { changes };
  }

  async insert(sql: string, params?: SqlParam[]): Promise<InsertResult> {
    const d = this.d();
    d.run(sql, toSqlValues(params));
    const changes = d.getRowsModified();
    this.dirty = true;
    if (changes < 1) return { id: null };
    // last_insert_rowid() reflects the most recent INSERT on this connection.
    const stmt = d.prepare("SELECT last_insert_rowid() AS id");
    try {
      stmt.step();
      const row = stmt.getAsObject() as { id: number };
      return { id: Number(row.id) };
    } finally {
      stmt.free();
    }
  }

  async exec(sql: string): Promise<void> {
    const d = this.d();
    d.exec(sql);
    this.dirty = true;
  }

  async batch(statements: BatchStatement[]): Promise<void> {
    const d = this.d();
    d.run("BEGIN");
    try {
      for (const stmt of statements) {
        d.run(stmt.sql, toSqlValues(stmt.params));
      }
      d.run("COMMIT");
      this.dirty = true;
    } catch (err) {
      try {
        d.run("ROLLBACK");
      } catch {
        /* ignore rollback failure; original error is more useful */
      }
      throw err;
    }
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const d = this.d();
    d.run("BEGIN");
    try {
      const result = await fn();
      d.run("COMMIT");
      this.dirty = true;
      return result;
    } catch (err) {
      try {
        d.run("ROLLBACK");
      } catch {
        /* ignore rollback failure; original error is more useful */
      }
      throw err;
    }
  }

  async sync(): Promise<void> {
    if (this.dirty) {
      this.saveToDisk();
      this.dirty = false;
    }
  }

  async close(): Promise<void> {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.db) {
      this.saveToDisk();
      this.db.close();
      this.db = null;
    }
    this.dirty = false;
  }

  /** Flush the in-memory database bytes to the file path. Swallows IO errors. */
  private saveToDisk(): void {
    if (!this.db) return;
    try {
      // sql.js export() returns Uint8Array; fs.writeFileSync accepts it
      // directly, avoiding a redundant Buffer.from() copy.
      const data = this.db.export();
      fs.writeFileSync(this.dbPath, data);
    } catch (err) {
      console.error("[sqlite-driver] Failed to save database:", err);
    }
  }
}
