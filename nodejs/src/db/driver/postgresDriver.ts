/**
 * PostgreSQL driver backed by `pg` (node-postgres).
 *
 * Implements the dialect-agnostic {@link DbDriver} contract on top of a
 * `pg.Pool`. Cloud writes commit immediately (each statement is its own
 * implicit transaction), so {@link PostgresDriver.sync} is a no-op.
 *
 * Responsibilities (engine layer only):
 *  - connection pooling via `pg.Pool`
 *  - `?` placeholder → `$N` conversion (code always uses `?`)
 *  - SQL execution (query/run/insert/exec/batch/transaction)
 *  - cross-dialect value coercion (bigint, boolean, Uint8Array)
 *
 * NOT handled here (kept in `database.ts` as business logic):
 *  - schema (CREATE TABLE / migrations), provider cache, usage flush.
 *
 * Transaction model (single-level, NOT nested):
 *  {@link PostgresDriver.transaction} checks out a dedicated `PoolClient`,
 *  stores it on `this.txClient`, and runs BEGIN/COMMIT/ROLLBACK on it. While
 *  a txClient is active, every query/run/insert/exec reuses the same client
 *  so statements execute within the transaction. Nested transactions are not
 *  supported (the inner call runs on the outer client without a savepoint).
 */

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

/**
 * Dynamically import `pg` so SQLite-only deployments never require it.
 *
 * We import only the types statically; the runtime module is loaded inside
 * {@link PostgresDriver.create}.
 */
type PgPool = {
  connect(): Promise<PgPoolClient>;
  query(text: string, values?: unknown[]): Promise<PgQueryResultLike>;
  end(): Promise<void>;
};
type PgPoolClient = {
  query(text: string, values?: unknown[]): Promise<PgQueryResultLike>;
  release(): void;
};
type PgQueryResultLike = {
  rows: Record<string, unknown>[];
  rowCount: number | null;
};

/** Constructor options for {@link PostgresDriver.create}. */
export interface PostgresDriverOptions {
  /** Full Postgres connection URL (e.g. `postgres://user:pass@host:5432/db`). */
  connectionString: string;
}

/**
 * Convert a cross-dialect {@link SqlParam} into a `pg`-native bind value.
 *
 * - bigint → string: `pg` sends parameters in the text protocol by default;
 *   binding a JS bigint works, but normalising to a string avoids any driver
 *   ambiguity and matches how 64-bit ids are typically exchanged.
 * - boolean → 0/1: columns are declared INTEGER across all dialects so that
 *   SQLite, Postgres and MySQL store booleans identically.
 * - Uint8Array → Buffer: `pg` expects Buffer for bytea columns.
 */
function toPgValue(p: SqlParam): unknown {
  if (typeof p === "bigint") return p.toString();
  if (typeof p === "boolean") return p ? 1 : 0;
  if (p instanceof Uint8Array) return Buffer.from(p);
  return p; // string | number | null
}

function toPgValues(params?: SqlParam[]): unknown[] | undefined {
  return params ? params.map(toPgValue) : undefined;
}

export class PostgresDriver implements DbDriver {
  readonly dialect: DbDialect = "postgres";

  private pool: PgPool | null = null;
  /** Active transaction client, or null when not inside a transaction. */
  private txClient: PgPoolClient | null = null;

  private constructor() {
    // Use {@link PostgresDriver.create} for initialisation.
  }

  /**
   * Create and initialise a driver for the given connection URL.
   *
   * `pg` is loaded via dynamic import so that deployments without the
   * `pg` package (SQLite-only) never trigger the require.
   */
  static async create(
    options: PostgresDriverOptions,
  ): Promise<PostgresDriver> {
    const driver = new PostgresDriver();
    await driver.init(options.connectionString);
    return driver;
  }

  private async init(connectionString: string): Promise<void> {
    // Dynamic import keeps `pg` optional for SQLite-only deployments.
    const pgModule = (await import("pg")) as {
      Pool: new (config: { connectionString: string }) => PgPool;
    };
    this.pool = new pgModule.Pool({ connectionString });
  }

  /** Ensure the pool is open and return it, or throw a contract error. */
  private p(): PgPool {
    const current = this.pool;
    if (!current) {
      throw new Error("PostgresDriver is not initialised or has been closed");
    }
    return current;
  }

  /**
   * Convert `?` placeholders into Postgres `$N` numbered placeholders.
   *
   * Only bare `?` markers are replaced; `??` (if ever used) would become two
   * independent placeholders. This mirrors how the rest of the codebase uses
   * parameters.
   */
  private convertPlaceholders(sql: string): string {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  /**
   * Run a parameterised statement on the active connection: the dedicated
   * transaction client when inside {@link transaction}, otherwise the pool.
   */
  private async runQuery(
    text: string,
    params?: SqlParam[],
  ): Promise<PgQueryResultLike> {
    const client = this.txClient;
    const values = toPgValues(params);
    if (client) return client.query(text, values);
    return this.p().query(text, values);
  }

  async query<T = DbRow>(
    sql: string,
    params?: SqlParam[],
  ): Promise<QueryResult<T>> {
    const text = this.convertPlaceholders(sql);
    const res = await this.runQuery(text, params);
    return { rows: res.rows as T[] };
  }

  async run(sql: string, params?: SqlParam[]): Promise<RunResult> {
    const text = this.convertPlaceholders(sql);
    const res = await this.runQuery(text, params);
    return { changes: res.rowCount ?? 0 };
  }

  async insert(sql: string, params?: SqlParam[]): Promise<InsertResult> {
    const isInsert = /^\s*INSERT\b/i.test(sql);
    const text = this.convertPlaceholders(sql);
    const hasReturning = /\bRETURNING\b/i.test(text);

    if (isInsert && !hasReturning) {
      // Append RETURNING id so we can read back the generated primary key.
      const res = await this.runQuery(`${text} RETURNING id`, params);
      const row = res.rows[0] as { id?: number } | undefined;
      return { id: row?.id ?? null };
    }

    // Non-INSERT statement, or INSERT already carrying its own RETURNING.
    const res = await this.runQuery(text, params);
    const row = res.rows[0] as { id?: number } | undefined;
    return { id: row?.id ?? null };
  }

  async exec(sql: string): Promise<void> {
    // Postgres does not support multiple statements in a single simple-query
    // call via parameterised paths; split on ';' for our DDL/migration text.
    const statements = this.splitStatements(sql);
    for (const stmt of statements) {
      await this.runQuery(stmt);
    }
  }

  /**
   * Split a multi-statement SQL string on top-level `;` separators.
   *
   * This is deliberately simple: our DDL and migration text never contains
   * `;` inside string literals or function bodies. Each non-empty fragment is
   * returned trimmed.
   */
  private splitStatements(sql: string): string[] {
    const out: string[] = [];
    for (const raw of sql.split(";")) {
      const stmt = raw.trim();
      if (stmt.length > 0) out.push(stmt);
    }
    return out;
  }

  async batch(statements: BatchStatement[]): Promise<void> {
    // Reuse transaction() so all statements commit or roll back atomically.
    await this.transaction(async () => {
      for (const stmt of statements) {
        await this.run(stmt.sql, stmt.params);
      }
    });
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // Nested calls reuse the outer transaction client (no savepoint).
    if (this.txClient) {
      return fn();
    }
    const client = await this.p().connect();
    this.txClient = client;
    try {
      await client.query("BEGIN");
      const result = await fn();
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore rollback failure; the original error is more useful */
      }
      throw err;
    } finally {
      this.txClient = null;
      client.release();
    }
  }

  async sync(): Promise<void> {
    // No-op: cloud drivers commit each statement immediately.
  }

  async close(): Promise<void> {
    const pool = this.pool;
    if (pool) {
      this.pool = null;
      await pool.end();
    }
    this.txClient = null;
  }
}
