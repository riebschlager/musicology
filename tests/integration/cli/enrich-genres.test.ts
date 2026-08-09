import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { repositoryRoot } from "../../../src/config/config.ts";
import { runGenreEnrichmentCommand } from "../../../src/cli/enrich-genres.ts";
import type { SqliteConnection } from "../../../src/db/connection.ts";
import { MusicbrainzGenreClient } from "../../../src/genre/musicbrainz-client.ts";
import {
  type TemporaryTestWorkspace,
  withTemporaryTestWorkspace,
} from "../../helpers/temporary-workspace.ts";

function runCli(
  workspace: TemporaryTestWorkspace,
  args: readonly string[],
  databasePath = workspace.configuration.paths.databasePath,
) {
  return spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "src/cli/enrich-genres.ts"), ...args],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        MUSICOLOGY_DATABASE_PATH: databasePath,
        MUSICOLOGY_TIMEZONE: "America/Chicago",
      },
    },
  );
}

function insertEligibleArtist(connection: SqliteConnection): {
  artistId: number;
  identifier: string;
} {
  const artistId = Number(
    connection
      .prepare("INSERT INTO music_entity (entity_type, created_at_epoch_ms) VALUES ('artist', 0)")
      .run().lastInsertRowid,
  );
  connection
    .prepare("INSERT INTO artist (id, preferred_name) VALUES (?, 'Synthetic Artist')")
    .run([artistId]);
  const trackId = Number(
    connection
      .prepare("INSERT INTO music_entity (entity_type, created_at_epoch_ms) VALUES ('track', 0)")
      .run().lastInsertRowid,
  );
  connection
    .prepare("INSERT INTO track (id, artist_id, preferred_title) VALUES (?, ?, 'Synthetic Track')")
    .run([trackId, artistId]);
  connection
    .prepare(
      `INSERT INTO listening_event (
        track_id, started_at_epoch_ms, ended_at_epoch_ms, time_basis, event_status,
        reconciliation_rule_version
      ) VALUES (?, 0, 0, 'observed_start', 'current', 'synthetic-v1')`,
    )
    .run([trackId]);
  const identifier = "c0ffee00-cafe-4000-8000-000000000008";
  connection
    .prepare(
      `INSERT INTO music_identifier (entity_id, namespace, identifier_value, is_strong)
       VALUES (?, 'musicbrainz_artist_id', ?, 1)`,
    )
    .run([artistId, identifier]);
  return { artistId, identifier };
}

function parseJsonResult(output: string): unknown {
  return JSON.parse(output.slice(Math.max(0, output.lastIndexOf("\n{") + 1)));
}

describe("enrich:genres CLI", () => {
  it("rejects invalid arguments without starting enrichment", () => {
    withTemporaryTestWorkspace((workspace) => {
      const completed = runCli(workspace, ["--json", "--limit", "0"]);

      assert.equal(completed.status, 2);
      assert.equal(completed.stdout, "");
      const result = parseJsonResult(completed.stderr) as {
        readonly errors: readonly { readonly code: string }[];
      };
      assert.equal(result.errors[0]?.code, "invalid_arguments");
    });
  });

  it("rejects a missing database without creating it or its parent directory", () => {
    withTemporaryTestWorkspace((workspace) => {
      const missingParent = path.join(workspace.rootPath, "missing-database-parent");
      const missingDatabase = path.join(missingParent, "musicology.sqlite3");
      const completed = runCli(workspace, ["--json"], missingDatabase);

      assert.equal(completed.status, 4);
      assert.equal(completed.stdout, "");
      assert.equal(existsSync(missingDatabase), false);
      assert.equal(existsSync(missingParent), false);
      assert.equal(completed.stderr.includes(missingDatabase), false);
    });
  });

  it("dry-runs a provider response without persisting it or returning raw evidence", async () => {
    await withTemporaryTestWorkspace(async (workspace) => {
      const { identifier } = insertEligibleArtist(workspace.connection);
      const client = new MusicbrainzGenreClient({
        transport: {
          async request() {
            return {
              status: 200,
              async text() {
                return JSON.stringify({
                  id: identifier,
                  genres: [{ count: 5, name: "Synthetic Private Tag" }],
                });
              },
            };
          },
        },
      });

      const result = await runGenreEnrichmentCommand(workspace.connection, client, {
        dryRun: true,
      });
      assert.equal(result.status, "success");
      const data = result.data as {
        readonly actions: {
          readonly cached: number;
          readonly fetched: number;
          readonly skippedAmbiguousIdentity: number;
          readonly skippedLimit: number;
        };
        readonly dryRun: boolean;
      };
      assert.equal(data.dryRun, true);
      assert.deepEqual(data.actions, {
        cached: 0,
        fetched: 1,
        skippedAmbiguousIdentity: 0,
        skippedLimit: 0,
      });
      const serialized = JSON.stringify(result);
      assert.equal(serialized.includes("Synthetic Private Tag"), false);
      assert.equal(serialized.includes(identifier), false);
      assert.equal(
        workspace.connection
          .prepare("SELECT COUNT(*) AS count FROM genre_enrichment_snapshot")
          .get()?.count,
        0,
      );
      assert.equal(
        workspace.connection.prepare("SELECT COUNT(*) AS count FROM genre_enrichment_raw_tag").get()
          ?.count,
        0,
      );
    });
  });
});
