import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";

import {
  FILE_DATABASE_JOURNAL_MODE,
  openReadonlySqliteConnection,
} from "../../../src/db/better-sqlite3.ts";
import type { SqliteRow } from "../../../src/db/connection.ts";
import {
  createTemporarySqliteDatabase,
  withTemporarySqliteDatabase,
} from "../../../src/db/temporary.ts";

interface CountRow extends SqliteRow {
  readonly count: number;
}

interface PragmaValueRow extends SqliteRow {
  readonly foreign_keys?: number;
  readonly journal_mode?: string;
}

describe("SQLite connection policy", () => {
  it("enforces foreign keys and enables WAL for file databases", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      assert.equal(
        connection.prepare<PragmaValueRow>("PRAGMA foreign_keys").get()?.foreign_keys,
        1,
      );
      assert.equal(
        connection.prepare<PragmaValueRow>("PRAGMA journal_mode").get()?.journal_mode,
        FILE_DATABASE_JOURNAL_MODE,
      );

      connection.execute(`
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parent(id)
        );
      `);

      assert.throws(
        () => connection.prepare("INSERT INTO child (parent_id) VALUES (?)").run([999]),
        /FOREIGN KEY constraint failed/,
      );
    });
  });

  it("rolls back every change when a transaction throws", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      connection.execute("CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
      const insert = connection.prepare("INSERT INTO item (name) VALUES (@name)");

      assert.throws(
        () =>
          connection.transaction((transactionConnection) => {
            assert.equal(transactionConnection.isInTransaction, true);
            insert.run({ name: "first" });
            insert.run({ name: "second" });
            throw new Error("force rollback");
          }),
        /force rollback/,
      );

      const row = connection.prepare<CountRow>("SELECT count(*) AS count FROM item").get();
      assert.equal(row?.count, 0);
      assert.equal(connection.isInTransaction, false);
    });
  });

  it("opens an existing database read-only without changing its journal mode", () => {
    const temporary = createTemporarySqliteDatabase();
    temporary.connection.execute("CREATE TABLE item (id INTEGER PRIMARY KEY)");
    temporary.connection.execute("PRAGMA journal_mode = DELETE");
    temporary.connection.close();

    const readonlyConnection = openReadonlySqliteConnection(temporary.databasePath);
    try {
      assert.equal(
        readonlyConnection.prepare<PragmaValueRow>("PRAGMA foreign_keys").get()?.foreign_keys,
        1,
      );
      assert.equal(
        readonlyConnection.prepare<PragmaValueRow>("PRAGMA journal_mode").get()?.journal_mode,
        "delete",
      );
      assert.throws(
        () => readonlyConnection.prepare("INSERT INTO item DEFAULT VALUES").run(),
        /readonly database/,
      );
    } finally {
      readonlyConnection.close();
      temporary.cleanup();
    }
  });

  it("returns a successful database and foreign-key integrity check", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      connection.execute(`
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (parent_id INTEGER NOT NULL REFERENCES parent(id));
        INSERT INTO parent (id) VALUES (1);
        INSERT INTO child (parent_id) VALUES (1);
      `);

      assert.deepEqual(connection.checkIntegrity(), {
        ok: true,
        messages: ["ok"],
        foreignKeyViolations: [],
      });
    });
  });

  it("closes connections and removes temporary database files even after failure", () => {
    const temporary = createTemporarySqliteDatabase();
    const { connection, directoryPath } = temporary;

    assert.equal(connection.isOpen, true);
    assert.equal(existsSync(directoryPath), true);
    temporary.cleanup();
    temporary.cleanup();
    assert.equal(connection.isOpen, false);
    assert.equal(existsSync(directoryPath), false);

    let failedDatabase: ReturnType<typeof createTemporarySqliteDatabase> | undefined;
    assert.throws(
      () =>
        withTemporarySqliteDatabase((database) => {
          failedDatabase = database;
          throw new Error("operation failed");
        }),
      /operation failed/,
    );
    assert.equal(failedDatabase?.connection.isOpen, false);
    assert.equal(existsSync(failedDatabase?.directoryPath ?? ""), false);
  });
});
