/**
 * SQL dialect fragments.
 *
 * Single source of truth for the small set of raw-SQL pieces that differ
 * across SQLite / Postgres / MySQL. Most queries in `database.ts` are
 * dialect-neutral (we deliberately store timestamps and JSON as TEXT), so
 * only the handful of truly divergent fragments live here.
 *
 * Usage: build SQL with `${NOW[driver.dialect]}` where a current-timestamp
 * expression is needed.
 *
 * Add new fragments here only when a query genuinely cannot be written in a
 * portable form; prefer driver-side parameter conversion for placeholders.
 */

import type { DbDialect } from "./driver/types.js";

/**
 * Current-timestamp expression per dialect.
 *
 * - SQLite: `datetime('now')` returns UTC "YYYY-MM-DD HH:MM:SS", matching the
 *   historical storage format.
 * - Postgres / MySQL: `NOW()` returns the dialect timestamp; because we store
 *   into TEXT columns it is cast to the same string format on write.
 */
export const NOW: Readonly<Record<DbDialect, string>> = Object.freeze({
  sqlite: "datetime('now')",
  // PG NOW() into TEXT yields "2026-07-10 12:34:56.789012+00" (timezone+micros)
  // which breaks the canonical "YYYY-MM-DD HH:MM:SS" format — format explicitly.
  postgres: "to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')",
  // MySQL NOW() cast into TEXT already matches "YYYY-MM-DD HH:MM:SS".
  mysql: "NOW()",
});

/**
 * Convenience helper returning the current-timestamp expression for a dialect.
 */
export function dialectNow(dialect: DbDialect): string {
  return NOW[dialect];
}

/**
 * Period-matching SQL fragment for usage quota queries.
 *
 * `columnExpr` is the column reference used in the comparison — either
 * `created_at` (when filtering by api_key directly) or `u.created_at` (when
 * joining through api_keys). The caller controls the alias prefix.
 *
 * - day:   rows whose timestamp falls on today's calendar date
 * - month: rows whose timestamp falls in the current calendar month
 */
export function periodCondition(
  period: "day" | "month",
  dialect: DbDialect,
  columnExpr: string,
): string {
  if (period === "day") {
    switch (dialect) {
      case "sqlite":
        return `date(${columnExpr}) = date('now')`;
      case "postgres":
        return `${columnExpr}::date = CURRENT_DATE`;
      case "mysql":
        return `DATE(${columnExpr}) = CURDATE()`;
    }
  }
  switch (dialect) {
    case "sqlite":
      return `strftime('%Y-%m', ${columnExpr}) = strftime('%Y-%m', 'now')`;
    case "postgres":
      return `TO_CHAR(${columnExpr}::date, 'YYYY-MM') = TO_CHAR(CURRENT_DATE, 'YYYY-MM')`;
    case "mysql":
      return `DATE_FORMAT(${columnExpr}, '%Y-%m') = DATE_FORMAT(CURDATE(), '%Y-%m')`;
  }
}

/**
 * MySQL reserved words that collide with our column/table names.
 *
 * `key` is a reserved word in MySQL (but tolerated bare by SQLite & PG). We
 * only list identifiers that are actually used bare in our SQL; other columns
 * (`usage` table, `mode`, `value`) are non-reserved keywords and need no quoting.
 */
const MYSQL_RESERVED = new Set(["key"]);

/**
 * Quote an SQL identifier for the given dialect.
 *
 * MySQL requires backtick-quoting reserved words (e.g. `key`). SQLite and
 * Postgres tolerate them bare, so for those dialects the name is returned
 * unchanged (zero behavioural change for existing SQLite deployments).
 */
export function quoteIdent(name: string, dialect: DbDialect): string {
  if (dialect === "mysql" && MYSQL_RESERVED.has(name.toLowerCase())) {
    return "`" + name + "`";
  }
  return name;
}
/**
 * Dialect-aware CAST(... AS TEXT) expression.
 *
 * MySQL's CAST does not support `AS TEXT` (only CHAR/BINARY/DATE/...), so we
 * emit `AS CHAR` there. SQLite and Postgres support `AS TEXT` natively.
 */
export function castAsText(expr: string, dialect: DbDialect): string {
  const as = dialect === "mysql" ? "CHAR" : "TEXT";
  return `CAST(${expr} AS ${as})`;
}

/**
 * Build a dialect-aware UPSERT statement (INSERT ... ON CONFLICT / ON DUPLICATE
 * KEY UPDATE).
 *
 * When `hasTimestamps` is true, `created_at` and `updated_at` are appended to
 * the INSERT columns using the dialect's NOW expression (no params for them),
 * and the UPDATE clause refreshes `updated_at`. Pass only business-column
 * values as params, in `businessCols` order.
 *
 * Column names are run through `quoteIdent` so reserved words like `key` are
 * backtick-quoted on MySQL automatically.
 *
 *   SQLite/PG: INSERT INTO t (a,b,created_at,updated_at) VALUES (?,?,NOW,NOW)
 *              ON CONFLICT(x) DO UPDATE SET a=excluded.a, updated_at=excluded.updated_at
 *   MySQL:     INSERT INTO t (a,b,created_at,updated_at) VALUES (?,?,NOW,NOW)
 *              ON DUPLICATE KEY UPDATE a=VALUES(a), updated_at=VALUES(updated_at)
 *
 * For tables without timestamp columns (e.g. settings, model_mappings) pass
 * `hasTimestamps: false`.
 */
export function buildUpsertSql(
  dialect: DbDialect,
  table: string,
  businessCols: readonly string[],
  conflictCols: readonly string[],
  updateCols: readonly string[],
  hasTimestamps: boolean,
): string {
  const now = NOW[dialect];
  const q = (name: string): string => quoteIdent(name, dialect);
  const allCols = hasTimestamps
    ? [...businessCols, "created_at", "updated_at"]
    : businessCols;
  const placeholders = businessCols.map(() => "?").join(", ");
  const tsValues = hasTimestamps ? `, ${now}, ${now}` : "";
  const colList = allCols.map(q).join(", ");

  if (dialect === "mysql") {
    const updates = updateCols.map((c) => `${q(c)} = VALUES(${q(c)})`).join(", ");
    const tsUpdate = hasTimestamps ? `, updated_at = VALUES(updated_at)` : "";
    return `INSERT INTO ${table} (${colList}) VALUES (${placeholders}${tsValues}) ON DUPLICATE KEY UPDATE ${updates}${tsUpdate}`;
  }
  const updates = updateCols.map((c) => `${q(c)} = excluded.${q(c)}`).join(", ");
  const tsUpdate = hasTimestamps ? `, updated_at = excluded.updated_at` : "";
  return `INSERT INTO ${table} (${colList}) VALUES (${placeholders}${tsValues}) ON CONFLICT(${conflictCols.map(q).join(", ")}) DO UPDATE SET ${updates}${tsUpdate}`;
}
