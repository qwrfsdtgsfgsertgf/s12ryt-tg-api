/**
 * Unit tests for src/db/driver/factory.ts
 *
 * Verifies the driver selection logic: SQLite fallback when no URL is given,
 * and clear English contract errors for cloud schemes that are not yet
 * implemented (stage 3/4) or unsupported.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";

import { createDriver } from "../src/db/driver/factory.js";
import { SqliteDriver } from "../src/db/driver/sqliteDriver.js";

function tmpDbPath(): string {
  return path.join(
    os.tmpdir(),
    `oreo-factory-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

describe("createDriver", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
  });

  afterEach(() => {
    try {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  });

  it("returns a SqliteDriver when no databaseUrl is provided", async () => {
    const driver = await createDriver({ sqlitePath: dbPath });
    expect(driver).toBeInstanceOf(SqliteDriver);
    expect(driver.dialect).toBe("sqlite");
    await driver.close();
  });

  it("returns a SqliteDriver when databaseUrl is undefined explicitly", async () => {
    const driver = await createDriver({ sqlitePath: dbPath, databaseUrl: undefined });
    expect(driver.dialect).toBe("sqlite");
    await driver.close();
  });

  it("returns a PostgresDriver for postgres:// scheme", async () => {
    const driver = await createDriver({
      sqlitePath: dbPath,
      databaseUrl: "postgres://user:pass@host:5432/db",
    });
    expect(driver.dialect).toBe("postgres");
    await driver.close();
  });

  it("returns a PostgresDriver for postgresql:// scheme", async () => {
    const driver = await createDriver({
      sqlitePath: dbPath,
      databaseUrl: "postgresql://user:pass@host:5432/db",
    });
    expect(driver.dialect).toBe("postgres");
    await driver.close();
  });

  it("returns a MysqlDriver for mysql:// scheme", async () => {
    const driver = await createDriver({
      sqlitePath: dbPath,
      databaseUrl: "mysql://user:pass@host:3306/db",
    });
    expect(driver.dialect).toBe("mysql");
    await driver.close();
  });

  it("returns a MysqlDriver for mariadb:// scheme", async () => {
    const driver = await createDriver({
      sqlitePath: dbPath,
      databaseUrl: "mariadb://user:pass@host:3306/db",
    });
    expect(driver.dialect).toBe("mysql");
    await driver.close();
  });

  it("throws an unsupported-scheme error for unknown protocols", async () => {
    await expect(
      createDriver({
        sqlitePath: dbPath,
        databaseUrl: "mongodb://user:pass@host:27017/db",
      }),
    ).rejects.toThrow(/Unsupported DATABASE_URL scheme/i);

    await expect(
      createDriver({
        sqlitePath: dbPath,
        databaseUrl: "oracle://user:pass@host/db",
      }),
    ).rejects.toThrow(/Unsupported DATABASE_URL scheme/i);
  });
});
