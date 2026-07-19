import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openSqliteConnection } from "./better-sqlite3.ts";
import type { SqliteConnection } from "./connection.ts";

export interface TemporarySqliteDatabase {
  readonly directoryPath: string;
  readonly databasePath: string;
  readonly connection: SqliteConnection;
  cleanup(): void;
}

export function createTemporarySqliteDatabase(): TemporarySqliteDatabase {
  const directoryPath = mkdtempSync(path.join(tmpdir(), "musicology-sqlite-"));
  const databasePath = path.join(directoryPath, "database.sqlite3");

  try {
    const connection = openSqliteConnection(databasePath);
    return {
      directoryPath,
      databasePath,
      connection,
      cleanup(): void {
        try {
          connection.close();
        } finally {
          if (existsSync(directoryPath)) {
            rmSync(directoryPath, { recursive: true });
          }
        }
      },
    };
  } catch (error) {
    rmSync(directoryPath, { force: true, recursive: true });
    throw error;
  }
}

export function withTemporarySqliteDatabase<T>(
  operation: (database: TemporarySqliteDatabase) => T,
): T {
  const database = createTemporarySqliteDatabase();
  try {
    return operation(database);
  } finally {
    database.cleanup();
  }
}
