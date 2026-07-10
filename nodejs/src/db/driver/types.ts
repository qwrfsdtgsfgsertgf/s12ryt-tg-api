/**
 * Database driver abstraction layer.
 *
 * This module defines the dialect-agnostic {@link DbDriver} interface that
 * `database.ts` consumes. Concrete implementations (SQLite/Postgres/MySQL)
 * live alongside this file and are selected by the factory.
 *
 * Design contract:
 * - All methods are async. The SQLite driver wraps synchronous sql.js calls
 *   in immediately-resolved Promises so the rest of the codebase can be fully
 *   async without a separate sync path.
 * - SQL placeholders are ALWAYS `?` in code passed to this interface. Each
 *   driver converts to its native form internally (e.g. Postgres `$1,$2`).
 * - Value types are cross-dialect: numbers, strings, bigints, booleans, null,
 *   and Buffer/Uint8Array for blobs. Drivers normalise as needed.
 * - Error messages thrown here are English (developer/contract-facing).
 */

/** Supported database dialects. */
export type DbDialect = "sqlite" | "postgres" | "mysql";

/**
 * A single SQL parameter value, shared across all dialects.
 *
 * Note: `bigint` is accepted for cases where 64-bit ids are needed; drivers
 * map it appropriately (SQLite stores as INTEGER, Postgres as BIGINT via
 * parameter binding, MySQL as signed BIGINT).
 */
export type SqlParam = string | number | bigint | boolean | null | Uint8Array;

/** A query result row represented as a loose column map. Callers cast as needed. */
export type DbRow = Record<string, unknown>;

/** Result of a SELECT-style query. */
export interface QueryResult<T = DbRow> {
  rows: T[];
}

/** Result of an INSERT/UPDATE/DELETE that does not need the generated id. */
export interface RunResult {
  /** Number of rows affected. */
  changes: number;
}

/** Result of an INSERT that returns the generated primary key id. */
export interface InsertResult {
  /**
   * The new row's primary key id, or `null` when the statement did not
   * produce a single-row auto-increment insert.
   *
   * Dialect behaviour:
   * - SQLite: `SELECT last_insert_rowid()` after the insert.
   * - Postgres: `INSERT ... RETURNING id`.
   * - MySQL: `LAST_INSERT_ID()`.
   */
  id: number | null;
}

/** A single statement for batch execution inside one transaction. */
export interface BatchStatement {
  sql: string;
  params?: SqlParam[];
}

/**
 * Dialect-agnostic database driver.
 *
 * Implementations must be safe to share across the process lifetime; connection
 * pooling (for cloud drivers) is managed internally. Callers must not assume
 * any method runs on a stable underlying connection outside of
 * {@link DbDriver.transaction}.
 */
export interface DbDriver {
  /** Identifier of the active dialect. */
  readonly dialect: DbDialect;

  /**
   * Execute a SELECT and return all matching rows.
   * Throws on SQL error.
   */
  query<T = DbRow>(sql: string, params?: SqlParam[]): Promise<QueryResult<T>>;

  /**
   * Execute an INSERT/UPDATE/DELETE and return the affected row count.
   * Use {@link DbDriver.insert} when the generated id is required.
   * Throws on SQL error.
   */
  run(sql: string, params?: SqlParam[]): Promise<RunResult>;

  /**
   * Execute a single-row INSERT and return the generated primary key id.
   *
   * The driver decides how to obtain the id per dialect (see
   * {@link InsertResult.id}). The supplied `sql` should be a plain INSERT
   * without a RETURNING clause; the driver adds RETURNING for Postgres if
   * needed.
   */
  insert(sql: string, params?: SqlParam[]): Promise<InsertResult>;

  /**
   * Execute one or more raw SQL statements (typically DDL or migration text).
   * No parameter binding. Throws on SQL error.
   */
  exec(sql: string): Promise<void>;

  /**
   * Execute a batch of statements atomically inside a single transaction.
   * If any statement fails the whole batch is rolled back.
   */
  batch(statements: BatchStatement[]): Promise<void>;

  /**
   * Run `fn` inside a transaction. If `fn` resolves the transaction commits;
   * if it rejects (or the driver errors) the transaction rolls back.
   *
   * Nested calls reuse the outer transaction (savepoint semantics are NOT
   * guaranteed; avoid nesting). Statements executed via this driver's other
   * methods inside `fn` are part of the transaction.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  /**
   * Ensure all writes performed so far are durably persisted.
   *
   * - SQLite: flushes the in-memory database to the file (saveDb).
   * - Cloud drivers: no-op (each statement commits immediately within its
   *   own implicit transaction).
   *
   * Used to preserve the historical "critical write" guarantee where certain
   * operations were persisted synchronously.
   */
  sync(): Promise<void>;

  /** Release all resources (connections, timers). Idempotent. */
  close(): Promise<void>;
}
