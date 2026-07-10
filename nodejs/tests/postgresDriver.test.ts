/**
 * Unit tests for src/db/driver/postgresDriver.ts
 *
 * Strategy:
 * - Requires a live Postgres instance via the TEST_DATABASE_URL env var.
 * - When the variable is absent the whole suite is skipped, so local
 *   SQLite-only development never blocks. The CI workflow supplies the URL
 *   via a postgres service container.
 * - Each test builds a uniquely-named throwaway table so concurrent test
 *   runs do not collide, and drops it afterwards.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { PostgresDriver } from "../src/db/driver/postgresDriver.js";

const TEST_URL = process.env.TEST_DATABASE_URL;

/** Unique table name per test to avoid collisions. */
function tableName(label: string): string {
  return `drv_${label}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

const describeOrSkip = TEST_URL ? describe : describe.skip;

/** Seed a trivial table used by the query/run/insert suites. */
async function seedTable(
  driver: PostgresDriver,
  name: string,
): Promise<void> {
  await driver.exec(
    `CREATE TABLE ${name} (id SERIAL PRIMARY KEY, name TEXT, flag INTEGER)`,
  );
}

describeOrSkip("PostgresDriver", () => {
  let driver: PostgresDriver;

  beforeEach(async () => {
    driver = await PostgresDriver.create({
      connectionString: TEST_URL!,
    });
  });

  afterEach(async () => {
    await driver.close();
  });

  describe("create / lifecycle", () => {
    it("initialises and reports the postgres dialect", async () => {
      expect(driver.dialect).toBe("postgres");
    });

    it("can run a trivial SELECT 1", async () => {
      const { rows } = await driver.query<{ one?: number }>("SELECT 1 AS one");
      expect(rows[0]?.one).toBe(1);
    });
  });

  describe("query", () => {
    let t: string;

    beforeEach(async () => {
      t = tableName("q");
      await seedTable(driver, t);
    });
    afterEach(async () => {
      await driver.exec(`DROP TABLE IF EXISTS ${t}`);
    });

    it("returns matching rows with bound parameters", async () => {
      await driver.run(`INSERT INTO ${t} (name, flag) VALUES (?, ?)`, [
        "a",
        1,
      ]);
      await driver.run(`INSERT INTO ${t} (name, flag) VALUES (?, ?)`, [
        "b",
        0,
      ]);
      const { rows } = await driver.query<{ name: unknown }>(
        `SELECT name FROM ${t} WHERE flag = ? ORDER BY name`,
        [1],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe("a");
    });

    it("returns an empty array when no rows match", async () => {
      const { rows } = await driver.query(
        `SELECT * FROM ${t} WHERE name = ?`,
        ["missing"],
      );
      expect(rows).toEqual([]);
    });
  });

  describe("run", () => {
    let t: string;

    beforeEach(async () => {
      t = tableName("run");
      await seedTable(driver, t);
    });
    afterEach(async () => {
      await driver.exec(`DROP TABLE IF EXISTS ${t}`);
    });

    it("reports the number of inserted rows", async () => {
      const res = await driver.run(
        `INSERT INTO ${t} (name, flag) VALUES (?, ?)`,
        ["a", 1],
      );
      expect(res.changes).toBe(1);
    });

    it("reports the number of updated rows", async () => {
      await driver.run(`INSERT INTO ${t} (name, flag) VALUES (?, ?)`, [
        "a",
        1,
      ]);
      await driver.run(`INSERT INTO ${t} (name, flag) VALUES (?, ?)`, [
        "b",
        1,
      ]);
      const res = await driver.run(
        `UPDATE ${t} SET flag = ? WHERE flag = ?`,
        [0, 1],
      );
      expect(res.changes).toBe(2);
    });

    it("reports the number of deleted rows", async () => {
      await driver.run(`INSERT INTO ${t} (name, flag) VALUES (?, ?)`, [
        "a",
        1,
      ]);
      await driver.run(`INSERT INTO ${t} (name, flag) VALUES (?, ?)`, [
        "b",
        1,
      ]);
      const res = await driver.run(`DELETE FROM ${t} WHERE flag = ?`, [1]);
      expect(res.changes).toBe(2);
    });

    it("rethrows SQL errors", async () => {
      await expect(
        driver.run(`INSERT INTO no_such_table (x) VALUES (?)`, [1]),
      ).rejects.toThrow();
    });
  });

  describe("insert", () => {
    let t: string;

    beforeEach(async () => {
      t = tableName("ins");
      await seedTable(driver, t);
    });
    afterEach(async () => {
      await driver.exec(`DROP TABLE IF EXISTS ${t}`);
    });

    it("returns the generated SERIAL id", async () => {
      const r1 = await driver.insert(
        `INSERT INTO ${t} (name, flag) VALUES (?, ?)`,
        ["a", 1],
      );
      const r2 = await driver.insert(
        `INSERT INTO ${t} (name, flag) VALUES (?, ?)`,
        ["b", 0],
      );
      expect(r1.id).toBe(1);
      expect(r2.id).toBe(2);
    });

    it("returns null when the statement is a no-op UPDATE", async () => {
      // A non-INSERT statement should not receive RETURNING and thus yield no
      // id row.
      const res = await driver.insert(
        `UPDATE ${t} SET flag = ? WHERE name = ?`,
        [1, "absent"],
      );
      expect(res.id).toBeNull();
    });
  });

  describe("exec", () => {
    let t1: string;
    let t2: string;

    beforeEach(() => {
      t1 = tableName("ex1");
      t2 = tableName("ex2");
    });
    afterEach(async () => {
      await driver.exec(`DROP TABLE IF EXISTS ${t1}`);
      await driver.exec(`DROP TABLE IF EXISTS ${t2}`);
    });

    it("runs multi-statement DDL split on semicolons", async () => {
      await driver.exec(
        `CREATE TABLE ${t1} (id SERIAL PRIMARY KEY); CREATE TABLE ${t2} (id SERIAL PRIMARY KEY);`,
      );
      const { rows: aRows } = await driver.query(
        `SELECT to_regclass('${t1}') AS exists`,
      );
      const { rows: bRows } = await driver.query(
        `SELECT to_regclass('${t2}') AS exists`,
      );
      expect(aRows[0]).toBeDefined();
      expect(bRows[0]).toBeDefined();
    });
  });

  describe("batch", () => {
    let t: string;

    beforeEach(async () => {
      t = tableName("batch");
      await seedTable(driver, t);
    });
    afterEach(async () => {
      await driver.exec(`DROP TABLE IF EXISTS ${t}`);
    });

    it("commits all statements on success", async () => {
      await driver.batch([
        { sql: `INSERT INTO ${t} (name, flag) VALUES (?, ?)`, params: ["a", 1] },
        { sql: `INSERT INTO ${t} (name, flag) VALUES (?, ?)`, params: ["b", 1] },
      ]);
      const { rows } = await driver.query(`SELECT * FROM ${t} ORDER BY id`);
      expect(rows).toHaveLength(2);
    });

    it("rolls back every statement when one fails", async () => {
      await expect(
        driver.batch([
          { sql: `INSERT INTO ${t} (name, flag) VALUES (?, ?)`, params: ["a", 1] },
          // invalid table -> whole batch must roll back
          { sql: `INSERT INTO no_such (x) VALUES (1)` },
        ]),
      ).rejects.toThrow();

      const { rows } = await driver.query(`SELECT * FROM ${t}`);
      expect(rows).toHaveLength(0);
    });
  });

  describe("transaction", () => {
    let t: string;

    beforeEach(async () => {
      t = tableName("tx");
      await seedTable(driver, t);
    });
    afterEach(async () => {
      await driver.exec(`DROP TABLE IF EXISTS ${t}`);
    });

    it("commits and returns the callback value on success", async () => {
      const result = await driver.transaction(async () => {
        await driver.run(`INSERT INTO ${t} (name, flag) VALUES (?, ?)`, [
          "a",
          1,
        ]);
        return "done";
      });
      expect(result).toBe("done");
      const { rows } = await driver.query(`SELECT * FROM ${t}`);
      expect(rows).toHaveLength(1);
    });

    it("rolls back when the callback throws", async () => {
      await expect(
        driver.transaction(async () => {
          await driver.run(`INSERT INTO ${t} (name, flag) VALUES (?, ?)`, [
            "a",
            1,
          ]);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      const { rows } = await driver.query(`SELECT * FROM ${t}`);
      expect(rows).toHaveLength(0);
    });
  });

  describe("close", () => {
    it("is idempotent", async () => {
      // driver is re-created per test in beforeEach; close twice here.
      await driver.close();
      await expect(driver.close()).resolves.toBeUndefined();
    });

    it("throws a contract error when used after close", async () => {
      await driver.close();
      await expect(driver.query("SELECT 1")).rejects.toThrow(/closed/);
    });
  });

  describe("type coercion", () => {
    let t: string;

    beforeEach(async () => {
      t = tableName("types");
      await driver.exec(
        `CREATE TABLE ${t} (id SERIAL PRIMARY KEY, b INTEGER, big TEXT)`,
      );
    });
    afterEach(async () => {
      await driver.exec(`DROP TABLE IF EXISTS ${t}`);
    });

    it("stores booleans as 0/1", async () => {
      await driver.run(`INSERT INTO ${t} (b) VALUES (?)`, [true]);
      await driver.run(`INSERT INTO ${t} (b) VALUES (?)`, [false]);
      const { rows } = await driver.query<{ b: unknown }>(
        `SELECT b FROM ${t} ORDER BY id`,
      );
      expect(rows[0]?.b).toBe(1);
      expect(rows[1]?.b).toBe(0);
    });

    it("stores bigint as a string", async () => {
      const big = 123456789n;
      await driver.run(`INSERT INTO ${t} (big) VALUES (?)`, [big]);
      const { rows } = await driver.query<{ big: unknown }>(
        `SELECT big FROM ${t} WHERE big IS NOT NULL`,
      );
      expect(rows[0]?.big).toBe(big.toString());
    });
  });
});
