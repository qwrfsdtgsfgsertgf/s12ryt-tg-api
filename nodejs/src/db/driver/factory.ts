/**
 * Driver factory.
 *
 * Selects the concrete {@link DbDriver} implementation based on configuration.
 * The default and historical backend is SQLite (file on disk). When a
 * `databaseUrl` is provided its URL scheme selects a cloud driver:
 *  - `postgres://` / `postgresql://` -> Postgres driver (stage 3)
 *  - `mysql://` / `mariadb://`       -> MySQL driver   (stage 4)
 *
 * Cloud client libraries (`pg`, `mysql2`) are loaded via dynamic import only
 * when their driver is selected, so SQLite-only deployments never require them.
 */

import type { DbDriver } from "./types.js";
import { SqliteDriver } from "./sqliteDriver.js";

/** Options for {@link createDriver}. */
export interface CreateDriverOptions {
  /** SQLite database file path. Required fallback when no cloud URL is set. */
  sqlitePath: string;
  /**
   * Cloud database connection URL. When provided, its scheme selects a cloud
   * driver and `sqlitePath` is ignored. When omitted, SQLite is used.
   */
  databaseUrl?: string;
}

/** Supported cloud URL schemes mapped to their dialect. */
const POSTGRES_SCHEMES = new Set(["postgres", "postgresql"]);
const MYSQL_SCHEMES = new Set(["mysql", "mariadb"]);

/** Extract the lowercase URL scheme (e.g. "postgres", "mysql"), or "". */
function detectScheme(url: string): string {
  const match = url.match(/^([a-z][a-z0-9+.-]*):/i);
  return match ? match[1].toLowerCase() : "";
}

/**
 * Create the appropriate driver for the given options.
 *
 * Throws a clear, English contract error when a cloud driver is requested but
 * its backend is not yet implemented, or when the URL scheme is unsupported.
 */
export async function createDriver(options: CreateDriverOptions): Promise<DbDriver> {
  const { databaseUrl, sqlitePath } = options;

  if (databaseUrl) {
    const scheme = detectScheme(databaseUrl);
    if (POSTGRES_SCHEMES.has(scheme)) {
      // Dynamic import keeps `pg` optional for SQLite-only deployments.
      const { PostgresDriver } = await import("./postgresDriver.js");
      return PostgresDriver.create({ connectionString: databaseUrl });
    }
    if (MYSQL_SCHEMES.has(scheme)) {
      // Dynamic import keeps `mysql2` optional for SQLite-only deployments.
      const { MysqlDriver } = await import("./mysqlDriver.js");
      return MysqlDriver.create({ connectionString: databaseUrl });
    }
    throw new Error(
      `Unsupported DATABASE_URL scheme "${scheme}". ` +
        "Supported schemes: postgres://, postgresql://, mysql://, mariadb://."
    );
  }

  return SqliteDriver.create(sqlitePath);
}
