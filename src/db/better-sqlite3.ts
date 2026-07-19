import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type {
  ForeignKeyViolation,
  IntegrityCheckResult,
  PreparedStatement,
  SqliteConnection,
  SqliteParameters,
  SqliteRow,
  StatementRunResult,
  TransactionMode,
} from "./connection.ts";

export const SQLITE_BUSY_TIMEOUT_MS = 5_000;
export const FILE_DATABASE_JOURNAL_MODE = "wal";

interface IntegrityRow extends SqliteRow {
  readonly integrity_check: string;
}

interface ForeignKeyCheckRow extends SqliteRow {
  readonly table: string;
  readonly rowid: number | null;
  readonly parent: string;
  readonly fkid: number;
}

function parameterArguments(parameters: SqliteParameters | undefined): readonly unknown[] {
  if (parameters === undefined) {
    return [];
  }
  return Array.isArray(parameters) ? parameters : [parameters];
}

class BetterSqliteStatement<Row extends SqliteRow> implements PreparedStatement<Row> {
  private readonly statement: Database.Statement<unknown[], Row>;

  constructor(statement: Database.Statement<unknown[], Row>) {
    this.statement = statement;
  }

  run(parameters?: SqliteParameters): StatementRunResult {
    const result = this.statement.run(...parameterArguments(parameters));
    return {
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  get(parameters?: SqliteParameters): Row | undefined {
    return this.statement.get(...parameterArguments(parameters));
  }

  all(parameters?: SqliteParameters): readonly Row[] {
    return this.statement.all(...parameterArguments(parameters));
  }

  iterate(parameters?: SqliteParameters): IterableIterator<Row> {
    return this.statement.iterate(...parameterArguments(parameters));
  }
}

class BetterSqliteConnection implements SqliteConnection {
  readonly databasePath: string;
  private readonly database: Database.Database;

  constructor(databasePath: string, database: Database.Database) {
    this.databasePath = databasePath;
    this.database = database;
  }

  get isOpen(): boolean {
    return this.database.open;
  }

  get isInTransaction(): boolean {
    return this.database.inTransaction;
  }

  execute(sql: string): void {
    this.database.exec(sql);
  }

  prepare<Row extends SqliteRow = SqliteRow>(sql: string): PreparedStatement<Row> {
    return new BetterSqliteStatement(this.database.prepare<unknown[], Row>(sql));
  }

  transaction<T>(
    operation: (connection: SqliteConnection) => T,
    mode: TransactionMode = "immediate",
  ): T {
    const transaction = this.database.transaction(() => operation(this));
    return transaction[mode]();
  }

  checkIntegrity(): IntegrityCheckResult {
    const messages = this.prepare<IntegrityRow>("PRAGMA integrity_check")
      .all()
      .map((row) => row.integrity_check);
    const foreignKeyViolations = this.prepare<ForeignKeyCheckRow>("PRAGMA foreign_key_check")
      .all()
      .map(
        (row): ForeignKeyViolation => ({
          table: row.table,
          rowId: row.rowid,
          parentTable: row.parent,
          foreignKeyIndex: row.fkid,
        }),
      );

    return {
      ok: messages.length === 1 && messages[0] === "ok" && foreignKeyViolations.length === 0,
      messages,
      foreignKeyViolations,
    };
  }

  close(): void {
    if (this.database.open) {
      this.database.close();
    }
  }
}

function enableForeignKeys(database: Database.Database): void {
  database.pragma("foreign_keys = ON");
  const foreignKeysEnabled = database.pragma("foreign_keys", { simple: true });
  if (foreignKeysEnabled !== 1) {
    throw new Error("SQLite foreign-key enforcement could not be enabled");
  }
}

/**
 * Opens a writable connection using the project connection policy.
 *
 * Foreign-key enforcement is enabled for every connection. File-backed databases use WAL;
 * SQLite keeps its own `memory` journal mode for `:memory:` databases.
 */
export function openSqliteConnection(databasePath: string): SqliteConnection {
  const resolvedPath = databasePath === ":memory:" ? databasePath : path.resolve(databasePath);
  if (resolvedPath !== ":memory:") {
    mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  const database = new Database(resolvedPath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
  try {
    enableForeignKeys(database);

    if (resolvedPath !== ":memory:") {
      const journalMode = database.pragma("journal_mode = WAL", { simple: true });
      if (journalMode !== FILE_DATABASE_JOURNAL_MODE) {
        throw new Error(`SQLite WAL mode could not be enabled (received ${String(journalMode)})`);
      }
    }

    return new BetterSqliteConnection(resolvedPath, database);
  } catch (error) {
    database.close();
    throw error;
  }
}

/** Opens an existing file-backed database without creating files or changing journal mode. */
export function openReadonlySqliteConnection(databasePath: string): SqliteConnection {
  const resolvedPath = path.resolve(databasePath);
  const database = new Database(resolvedPath, {
    fileMustExist: true,
    readonly: true,
    timeout: SQLITE_BUSY_TIMEOUT_MS,
  });
  try {
    enableForeignKeys(database);
    return new BetterSqliteConnection(resolvedPath, database);
  } catch (error) {
    database.close();
    throw error;
  }
}
