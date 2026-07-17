import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { repositoryRoot } from "../../../src/config/config.ts";
import {
  buildLastfmScrobbleFixture,
  buildSpotifyTrackFixture,
  FIXTURE_TIMES,
  LASTFM_AMBIGUOUS_OVERLAP_FIXTURE,
  LASTFM_EXACT_DUPLICATE_FIXTURES,
  LASTFM_FIXTURE_CASES,
  SPOTIFY_AMBIGUOUS_OVERLAP_FIXTURES,
  SPOTIFY_EXACT_DUPLICATE_FIXTURES,
  SPOTIFY_FIXTURE_CASES,
  SYNTHETIC_FIXTURE_MARKER,
} from "../../fixtures/index.ts";
import {
  createTemporaryTestWorkspace,
  withTemporaryTestWorkspace,
} from "../../helpers/temporary-workspace.ts";

const EXCLUDED_FIXTURE_FIELDS = [
  "ip_address",
  "ip_addr",
  "username",
  "user_agent",
  "country",
  "platform",
  "api_key",
  "raw_payload",
] as const;
const fixturesDirectory = fileURLToPath(new URL("../../fixtures/", import.meta.url));

function allFixtureRecords(): readonly Readonly<Record<string, unknown>>[] {
  return [
    ...SPOTIFY_FIXTURE_CASES.map(({ record }) => record),
    ...SPOTIFY_EXACT_DUPLICATE_FIXTURES,
    ...SPOTIFY_AMBIGUOUS_OVERLAP_FIXTURES,
    ...LASTFM_FIXTURE_CASES.map(({ record }) => record),
    ...LASTFM_EXACT_DUPLICATE_FIXTURES,
    LASTFM_AMBIGUOUS_OVERLAP_FIXTURE,
  ];
}

describe("synthetic source fixtures", () => {
  it("covers every required P0-07 scenario", () => {
    assert.deepEqual(
      SPOTIFY_FIXTURE_CASES.map(({ case: fixtureCase }) => fixtureCase),
      [
        "valid_track",
        "missing_optional_data",
        "non_music_episode",
        "unicode",
        "time_boundary_before",
        "time_boundary_after",
        "malformed",
      ],
    );
    assert.deepEqual(
      LASTFM_FIXTURE_CASES.map(({ case: fixtureCase }) => fixtureCase),
      [
        "valid_scrobble",
        "missing_optional_data",
        "unicode",
        "time_boundary_before",
        "time_boundary_after",
        "malformed",
      ],
    );

    assert.deepEqual(SPOTIFY_EXACT_DUPLICATE_FIXTURES[0], SPOTIFY_EXACT_DUPLICATE_FIXTURES[1]);
    assert.notEqual(SPOTIFY_EXACT_DUPLICATE_FIXTURES[0], SPOTIFY_EXACT_DUPLICATE_FIXTURES[1]);
    assert.deepEqual(LASTFM_EXACT_DUPLICATE_FIXTURES[0], LASTFM_EXACT_DUPLICATE_FIXTURES[1]);

    const derivedStarts = SPOTIFY_AMBIGUOUS_OVERLAP_FIXTURES.map(
      (record) => Date.parse(record.ts) - record.ms_played,
    );
    assert.deepEqual(derivedStarts, [
      Date.parse(FIXTURE_TIMES.ambiguousLastfm),
      Date.parse(FIXTURE_TIMES.ambiguousLastfm),
    ]);
    assert.equal(
      LASTFM_AMBIGUOUS_OVERLAP_FIXTURE.timestamp,
      Date.parse(FIXTURE_TIMES.ambiguousLastfm),
    );
  });

  it("builds deterministic records without shared mutable state", () => {
    const spotifyFirst = buildSpotifyTrackFixture();
    const spotifySecond = buildSpotifyTrackFixture();
    const lastfmFirst = buildLastfmScrobbleFixture();
    const lastfmSecond = buildLastfmScrobbleFixture();

    assert.deepEqual(spotifyFirst, spotifySecond);
    assert.notEqual(spotifyFirst, spotifySecond);
    assert.deepEqual(lastfmFirst, lastfmSecond);
    assert.notEqual(lastfmFirst, lastfmSecond);
    assert.equal(JSON.stringify(allFixtureRecords()), JSON.stringify(allFixtureRecords()));
  });

  it("is explicitly synthetic, small, and contains no private or excluded fields", () => {
    assert.match(SYNTHETIC_FIXTURE_MARKER, /synthetic-fixture/);

    const records = allFixtureRecords();
    const serialized = JSON.stringify(records);
    assert.ok(Buffer.byteLength(serialized, "utf8") < 50_000);
    assert.match(serialized, /Synthetic|synthetic|Prueba|テスト/);

    const keys = records.flatMap((record) => Object.keys(record).map((key) => key.toLowerCase()));
    for (const excluded of EXCLUDED_FIXTURE_FIELDS) {
      assert.equal(
        keys.some((key) => key.includes(excluded)),
        false,
        `fixture key contains excluded field ${excluded}`,
      );
    }

    assert.equal(fixturesDirectory.startsWith(path.join(repositoryRoot, "data", "inputs")), false);
  });
});

describe("temporary test workspace", () => {
  it("creates a migrated isolated database and writes deterministic fixture files", () => {
    withTemporaryTestWorkspace((workspace) => {
      const repositoryInputs = path.join(repositoryRoot, "data", "inputs");
      assert.equal(
        workspace.configuration.paths.inputsDirectory.startsWith(repositoryInputs),
        false,
      );
      assert.equal(workspace.connection.checkIntegrity().ok, true);

      const fixturePath = workspace.writeJsonFixture("spotify/synthetic.json", {
        marker: SYNTHETIC_FIXTURE_MARKER,
        records: SPOTIFY_FIXTURE_CASES.map(({ record }) => record),
      });
      assert.equal(lstatSync(fixturePath).isSymbolicLink(), false);
      assert.equal(
        readFileSync(fixturePath, "utf8"),
        `${JSON.stringify(
          {
            marker: SYNTHETIC_FIXTURE_MARKER,
            records: SPOTIFY_FIXTURE_CASES.map(({ record }) => record),
          },
          null,
          2,
        )}\n`,
      );
    });
  });

  it("cleans up after success and failure and rejects paths outside the workspace", () => {
    const workspace = createTemporaryTestWorkspace();
    const { rootPath } = workspace;
    assert.throws(() => workspace.writeJsonFixture("../private.json", []), /must remain inside/);
    workspace.cleanup();
    workspace.cleanup();
    assert.equal(existsSync(rootPath), false);

    let failedRoot = "";
    assert.throws(
      () =>
        withTemporaryTestWorkspace((failedWorkspace) => {
          failedRoot = failedWorkspace.rootPath;
          throw new Error("intentional fixture test failure");
        }),
      /intentional fixture test failure/,
    );
    assert.equal(existsSync(failedRoot), false);
  });
});
