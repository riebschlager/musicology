import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import {
  commandFailure,
  commandSuccess,
  ExitCode,
  renderCommandResult,
  type CommandResult,
  type OutputFormat,
} from "./result.ts";
import { ConfigurationError, loadConfiguration, repositoryRoot } from "../config/config.ts";
import { openSqliteConnection } from "../db/better-sqlite3.ts";
import { getMigrationStatus } from "../db/migrations.ts";
import { exportGenreTaxonomy, importGenreTaxonomy } from "../genre/taxonomy-persistence.ts";

const commandName = "genre:taxonomy";

function usageFailure(summary: string): CommandResult {
  return commandFailure(commandName, ExitCode.UsageError, summary, [
    {
      code: "invalid_arguments",
      message:
        "Usage: genre:taxonomy --import artifact.json | --export taxonomy-version --output artifact.json [--json]",
    },
  ]);
}

function ensureCurrentMigrations(databasePath: string): void {
  const connection = openSqliteConnection(databasePath);
  try {
    const status = getMigrationStatus(
      connection,
      new URL("../../migrations/", import.meta.url).pathname,
    );
    if (!status.initialized || status.pending.length > 0) {
      throw new TypeError("Database migrations must be current before managing a genre taxonomy.");
    }
  } finally {
    connection.close();
  }
}

function main(): void {
  let format: OutputFormat = "human";
  let result: CommandResult;
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        export: { type: "string" },
        import: { type: "string" },
        json: { type: "boolean", default: false },
        output: { type: "string" },
      },
      strict: true,
    });
    format = parsed.values.json ? "json" : "human";
    if (parsed.positionals.length > 0) {
      result = usageFailure("The genre taxonomy command does not accept positional arguments.");
    } else if (
      parsed.values.import !== undefined &&
      parsed.values.export === undefined &&
      parsed.values.output === undefined
    ) {
      const configuration = loadConfiguration({ repositoryRoot });
      ensureCurrentMigrations(configuration.paths.databasePath);
      const artifact = JSON.parse(readFileSync(parsed.values.import, "utf8")) as unknown;
      const connection = openSqliteConnection(configuration.paths.databasePath);
      try {
        const imported = importGenreTaxonomy(connection, artifact);
        result = commandSuccess(commandName, "Genre taxonomy import completed.", {
          imported: imported.imported,
          taxonomyVersion: imported.taxonomyVersion,
        });
      } finally {
        connection.close();
      }
    } else if (
      parsed.values.export !== undefined &&
      parsed.values.import === undefined &&
      parsed.values.output !== undefined
    ) {
      if (existsSync(parsed.values.output)) {
        throw new TypeError("Genre taxonomy export destination already exists");
      }
      const configuration = loadConfiguration({ repositoryRoot });
      ensureCurrentMigrations(configuration.paths.databasePath);
      const connection = openSqliteConnection(configuration.paths.databasePath);
      try {
        const artifact = exportGenreTaxonomy(connection, parsed.values.export);
        writeFileSync(parsed.values.output, `${JSON.stringify(artifact, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
        result = commandSuccess(commandName, "Genre taxonomy export completed.", {
          taxonomyVersion: artifact.taxonomyVersion,
        });
      } finally {
        connection.close();
      }
    } else {
      result = usageFailure(
        "Specify either one import artifact or one taxonomy version and export destination.",
      );
    }
  } catch (error) {
    if (error instanceof ConfigurationError) {
      result = commandFailure(
        commandName,
        ExitCode.ConfigurationError,
        "Configuration is invalid.",
        error.issues.map((issue) => ({ code: issue.code, message: issue.message })),
      );
    } else if (error instanceof SyntaxError || error instanceof TypeError) {
      result = usageFailure("Genre taxonomy arguments or artifact are invalid.");
    } else {
      result = commandFailure(
        commandName,
        ExitCode.InternalError,
        "Genre taxonomy workflow failed.",
        [
          {
            code: "internal_error",
            message: "Genre taxonomy workflow failed without exporting artifact contents.",
          },
        ],
      );
    }
  }
  (result.status === "success" ? process.stdout : process.stderr).write(
    renderCommandResult(result, { format }),
  );
  process.exitCode = result.exitCode;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) main();
