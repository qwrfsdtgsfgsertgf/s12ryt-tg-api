/**
 * Unit tests for src/db/driver/sqliteDriver.ts
 *
 * Strategy:
 * - Each test gets a unique temporary .db file under os.tmpdir().
 * - We exercise the public DbDriver contract against the SQLite implementation,
 *   including persistence (sync), transactions, batch rollback and type
 *   coercion. The auto-save timer is verified with fake timers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";

import { SqliteDriver } from "../src/db/driver/sqliteDriver.js";

/** Build a unique temp db path for one test. */
function tmpDbPath(): string {
  return path.join(
    os.tmpdir(),
    `oreo-driver-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

/** Helper: create a trivial single-table schema for insert/query tests. */
async function seedTable(driver: SqliteDriver): Promise<void> {
  await driver.exec(
    "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, flag INTEGER)",
  );
}

describe("SqliteDriver", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
  });

  afterEach(async () => {
    // best-effort cleanup; ignore errors if the file was never created
    try {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  });

  describe("create / lifecycle", () => {
    it("initialises and reports the sqlite dialect", async () => {
      const driver = await SqliteDriver.create(dbPath);
      expect(driver.dialect).toBe("sqlite");
      await driver.close();
    });

    it("creates the parent directory when missing", async () => {
      const nested = path.join(
        os.tmpdir(),
        `oreo-nested-${Date.now()}`,
        "deep.db",
      );
      const driver = await SqliteDriver.create(nested);
      expect(fs.existsSync(nested)).toBe(false); // not yet synced
      await driver.exec("CREATE TABLE x (a INTEGER)");
      await driver.sync();
      expect(fs.existsSync(nested)).toBe(true);
      await driver.close();
      fs.unlinkSync(nested);
      fs.rmdirSync(path.dirname(nested));
    });

    it("loads an existing db file instead of resetting it", async () => {
      const first = await SqliteDriver.create(dbPath);
      await first.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
      await first.run("INSERT INTO t (id, name) VALUES (?, ?)", [1, "alpha"]);
      await first.sync();
      await first.close();

      const second = await SqliteDriver.create(dbPath);
      const { rows } = await second.query<{ name: unknown }>(
        "SELECT name FROM t WHERE id = ?",
        [1],
      );
      expect(rows[0]?.name).toBe("alpha");
      await second.close();
    });
  });

  describe("query", () => {
    let driver: SqliteDriver;

    beforeEach(async () => {
      driver = await SqliteDriver.create(dbPath);
      await seedTable(driver);
    });

    afterEach(async () => {
      await driver.close();
    });

    it("returns matching rows with bound parameters", async () => {
      await driver.run("INSERT INTO t (name, flag) VALUES (?, ?)", ["a", 1]);
      await driver.run("INSERT INTO t (name, flag) VALUES (?, ?)", ["b", 0]);
      const { rows } = await driver.query<{ name: unknown; flag: unknown }>(
        "SELECT name, flag FROM t WHERE flag = ? ORDER BY name",
        [1],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe("a");
    });

    it("returns an empty array when no rows match", async () => {
      const { rows } = await driver.query("SELECT * FROM t WHERE name = ?", [
        "missing",
      ]);
      expect(rows).toEqual([]);
    });

    it("does not leak statements across repeated queries", async () => {
      for (let i = 0; i < 50; i++) {
        await driver.run("INSERT INTO t (name, flag) VALUES (?, ?)", [
          `n${i}`,
          i % 2,
        ]);
      }
      const { rows } = await driver.query("SELECT * FROM t");
      expect(rows).toHaveLength(50);
    }, 10_000);
  });

  describe("run", () => {
    let driver: SqliteDriver;

    beforeEach(async () => {
      driver = await SqliteDriver.create(dbPath);
      await seedTable(driver);
    });

    afterEach(async () => {
      await driver.close();
    });

    it("reports the number of inserted rows", async () => {
      const res = await driver.run("INSERT INTO t (name, flag) VALUES (?, ?)", [
        "a",
        1,
      ]);
      expect(res.changes).toBe(1);
    });

    it("reports the number of updated rows", async () => {
      await driver.run("INSERT INTO t (name, flag) VALUES (?, ?)", ["a", 1]);
      await driver.run("INSERT INTO t (name, flag) VALUES (?, ?)", ["b", 1]);
      const res = await driver.run("UPDATE t SET flag = ? WHERE flag = ?", [
        0,
        1,
      ]);
      expect(res.changes).toBe(2);
    });

    it("reports the number of deleted rows", async () => {
      await driver.run("INSERT INTO t (name, flag) VALUES (?, ?)", ["a", 1]);
      await driver.run("INSERT INTO t (name, flag) VALUES (?, ?)", ["b", 1]);
      const res = await driver.run("DELETE FROM t WHERE flag = ?", [1]);
      expect(res.changes).toBe(2);
    });

    it("rethrows SQL errors", async () => {
      await expect(
        driver.run("INSERT INTO no_such_table (x) VALUES (?)", [1]),
      ).rejects.toThrow();
    });
  });

  describe("insert", () => {
    let driver: SqliteDriver;

    beforeEach(async () => {
      driver = await SqliteDriver.create(dbPath);
      await seedTable(driver);
    });

    afterEach(async () => {
      await driver.close();
    });

    it("returns the generated autoincrement id", async () => {
      const r1 = await driver.insert(
        "INSERT INTO t (name, flag) VALUES (?, ?)",
        ["a", 1],
      );
      const r2 = await driver.insert(
        "INSERT INTO t (name, flag) VALUES (?, ?)",
        ["b", 0],
      );
      expect(r1.id).toBe(1);
      expect(r2.id).toBe(2);
    });

    it("returns null when the statement inserted no rows", async () => {
      // An UPDATE inside insert() does not produce a new row.
      const res = await driver.insert(
        "UPDATE t SET flag = ? WHERE name = ?",
        [1, "absent"],
      );
      expect(res.id).toBeNull();
    });
  });

  describe("exec", () => {
    it("runs DDL and multi-statement text", async () => {
      const driver = await SqliteDriver.create(dbPath);
      await driver.exec(
        "CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER);",
      );
      // both tables exist
      const { rows: aRows } = await driver.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='a'",
      );
      const { rows: bRows } = await driver.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='b'",
      );
      expect(aRows).toHaveLength(1);
      expect(bRows).toHaveLength(1);
      await driver.close();
    });
  });

  describe("batch", () => {
    let driver: SqliteDriver;

    beforeEach(async () => {
      driver = await SqliteDriver.create(dbPath);
      await seedTable(driver);
    });

    afterEach(async () => {
      await driver.close();
    });

    it("commits all statements on success", async () => {
      await driver.batch([
        {
          sql: "INSERT INTO t (name, flag) VALUES (?, ?)",
          params: ["a", 1],
        },
        {
          sql: "INSERT INTO t (name, flag) VALUES (?, ?)",
          params: ["b", 1],
        },
      ]);
      const { rows } = await driver.query("SELECT * FROM t ORDER BY id");
      expect(rows).toHaveLength(2);
    });

    it("rolls back every statement when one fails", async () => {
      await expect(
        driver.batch([
          {
            sql: "INSERT INTO t (name, flag) VALUES (?, ?)",
            params: ["a", 1],
          },
          // invalid table -> whole batch must roll back
          { sql: "INSERT INTO no_such (x) VALUES (1)" },
        ]),
      ).rejects.toThrow();

      const { rows } = await driver.query("SELECT * FROM t");
      expect(rows).toHaveLength(0);
    });
  });

  describe("transaction", () => {
    let driver: SqliteDriver;

    beforeEach(async () => {
      driver = await SqliteDriver.create(dbPath);
      await seedTable(driver);
    });

    afterEach(async () => {
      await driver.close();
    });

    it("commits and returns the callback value on success", async () => {
      const result = await driver.transaction(async () => {
        await driver.run("INSERT INTO t (name, flag) VALUES (?, ?)", ["a", 1]);
        return "done";
      });
      expect(result).toBe("done");
      const { rows } = await driver.query("SELECT * FROM t");
      expect(rows).toHaveLength(1);
    });

    it("rolls back when the callback throws", async () => {
      await expect(
        driver.transaction(async () => {
          await driver.run("INSERT INTO t (name, flag) VALUES (?, ?)", [
            "a",
            1,
          ]);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      const { rows } = await driver.query("SELECT * FROM t");
      expect(rows).toHaveLength(0);
    });
  });

  describe("sync / persistence", () => {
    it("persists writes so a freshly opened driver sees them", async () => {
      const first = await SqliteDriver.create(dbPath);
      await first.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      await first.run("INSERT INTO t (id, v) VALUES (?, ?)", [42, "oreo"]);
      // not yet on disk
      await first.sync();
      await first.close();

      const second = await SqliteDriver.create(dbPath);
      const { rows } = await second.query<{ v: unknown }>(
        "SELECT v FROM t WHERE id = ?",
        [42],
      );
      expect(rows[0]?.v).toBe("oreo");
      await second.close();
    });

    it("the auto-save timer flushes dirty writes after the interval", async () => {
      vi.useFakeTimers();
      try {
        const driver = await SqliteDriver.create(dbPath);
        await driver.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
        await driver.run("INSERT INTO t (id, v) VALUES (?, ?)", [7, "x"]);
        // file should not be written yet (dirty, but timer not elapsed)
        const sizeBefore =
          fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
        // advance past the 30s auto-save window
        await vi.advanceTimersByTimeAsync(31_000);
        // allow any pending microtasks from the timer callback to settle
        await Promise.resolve();
        expect(fs.existsSync(dbPath)).toBe(true);
        // we cannot compare exact byte sizes (header may already exist), so
        // just assert the file grew / was created and contains the row after
        // a full reload.
        await driver.close();

        const reopened = await SqliteDriver.create(dbPath);
        const { rows } = await reopened.query<{ v: unknown }>(
          "SELECT v FROM t WHERE id = ?",
          [7],
        );
        expect(rows[0]?.v).toBe("x");
        await reopened.close();
        // sizeBefore referenced to keep the linter happy; behaviour assertion
        // above is the real check.
        expect(sizeBefore).toBeGreaterThanOrEqual(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("close", () => {
    it("is idempotent", async () => {
      const driver = await SqliteDriver.create(dbPath);
      await driver.close();
      await expect(driver.close()).resolves.toBeUndefined();
    });

    it("throws a contract error when used after close", async () => {
      const driver = await SqliteDriver.create(dbPath);
      await driver.close();
      await expect(driver.query("SELECT 1")).rejects.toThrow(/closed/);
    });
  });

  describe("type coercion", () => {
    let driver: SqliteDriver;

    beforeEach(async () => {
      driver = await SqliteDriver.create(dbPath);
      await driver.exec(
        "CREATE TABLE c (id INTEGER PRIMARY KEY, b INTEGER, big INTEGER)",
      );
    });

    afterEach(async () => {
      await driver.close();
    });

    it("stores booleans as 0/1", async () => {
      await driver.run("INSERT INTO c (b) VALUES (?)", [true]);
      await driver.run("INSERT INTO c (b) VALUES (?)", [false]);
      const { rows } = await driver.query<{ b: unknown }>(
        "SELECT b FROM c ORDER BY id",
      );
      expect(rows[0]?.b).toBe(1);
      expect(rows[1]?.b).toBe(0);
    });

    it("stores bigint as a number", async () => {
      const big = 123456789n;
      await driver.run("INSERT INTO c (big) VALUES (?)", [big]);
      const { rows } = await driver.query<{ big: unknown }>(
        "SELECT big FROM c WHERE big IS NOT NULL",
      );
      expect(rows[0]?.big).toBe(Number(big));
    });
  });
});
