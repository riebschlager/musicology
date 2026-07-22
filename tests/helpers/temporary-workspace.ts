import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfiguration, type ProjectConfiguration } from "../../src/config/config.ts";
import { openSqliteConnection } from "../../src/db/better-sqlite3.ts";
import type { SqliteConnection } from "../../src/db/connection.ts";
import { applyMigrations } from "../../src/db/migrations.ts";

const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));

export interface TemporaryTestWorkspace {
  readonly rootPath: string;
  readonly configuration: ProjectConfiguration;
  readonly connection: SqliteConnection;
  writeJsonFixture(relativePath: string, value: unknown): string;
  cleanup(): void;
}

export function createTemporaryTestWorkspace(): TemporaryTestWorkspace {
  const rootPath = mkdtempSync(path.join(tmpdir(), "musicology-test-workspace-"));
  const configuration = loadConfiguration({ environment: {}, repositoryRoot: rootPath });
  let connection: SqliteConnection | undefined;

  for (const directory of [
    configuration.paths.inputsDirectory,
    path.dirname(configuration.paths.databasePath),
    configuration.paths.outputsDirectory,
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  try {
    const openedConnection = openSqliteConnection(configuration.paths.databasePath);
    connection = openedConnection;
    applyMigrations(openedConnection, migrationsDirectory);

    return {
      rootPath,
      configuration,
      connection: openedConnection,
      writeJsonFixture(relativePath: string, value: unknown): string {
        if (path.isAbsolute(relativePath) || relativePath.split(path.sep).includes("..")) {
          throw new Error("Fixture path must remain inside the temporary inputs directory");
        }
        const fixturePath = path.join(configuration.paths.inputsDirectory, relativePath);
        mkdirSync(path.dirname(fixturePath), { recursive: true });
        writeFileSync(fixturePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
        return fixturePath;
      },
      cleanup(): void {
        try {
          openedConnection.close();
        } finally {
          if (existsSync(rootPath)) {
            rmSync(rootPath, { recursive: true });
          }
        }
      },
    };
  } catch (error) {
    try {
      connection?.close();
    } finally {
      rmSync(rootPath, { force: true, recursive: true });
    }
    throw error;
  }
}

export function withTemporaryTestWorkspace<T>(
  operation: (workspace: TemporaryTestWorkspace) => T,
): T {
  const workspace = createTemporaryTestWorkspace();
  try {
    const result = operation(workspace);
    if (isPromiseLike(result)) {
      return result.finally(() => workspace.cleanup()) as T;
    }
    workspace.cleanup();
    return result;
  } catch (error) {
    workspace.cleanup();
    throw error;
  }
}

function isPromiseLike<T>(value: T): value is T & Promise<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}
