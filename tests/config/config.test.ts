import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  ConfigurationError,
  DEFAULT_PRESENTATION_TIMEZONE,
  configurationRedactionValues,
  loadConfiguration,
} from "../../src/config/config.ts";

const testRoot = path.resolve("/tmp/musicology-configuration-test");

describe("project configuration", () => {
  it("uses repository-relative defaults without consulting the caller working directory", () => {
    const configuration = loadConfiguration({ environment: {}, repositoryRoot: testRoot });

    assert.deepEqual(configuration, {
      paths: {
        dataDirectory: path.join(testRoot, "data"),
        databasePath: path.join(testRoot, "data/database/musicology.sqlite3"),
        inputsDirectory: path.join(testRoot, "data/inputs"),
        outputsDirectory: path.join(testRoot, "data/outputs"),
      },
      presentationTimezone: DEFAULT_PRESENTATION_TIMEZONE,
      lastfm: {},
    });
  });

  it("resolves relative overrides from the repository and preserves absolute overrides", () => {
    const configuration = loadConfiguration({
      environment: {
        MUSICOLOGY_DATA_DIR: "local-data",
        MUSICOLOGY_DATABASE_PATH: "/var/tmp/musicology-test.sqlite3",
        MUSICOLOGY_INPUTS_DIR: "fixtures/inputs",
        MUSICOLOGY_OUTPUTS_DIR: "artifacts",
        MUSICOLOGY_TIMEZONE: "Europe/Berlin",
        LASTFM_USERNAME: "listener",
        LASTFM_API_KEY: "test-api-key",
      },
      repositoryRoot: testRoot,
    });

    assert.deepEqual(configuration.paths, {
      dataDirectory: path.join(testRoot, "local-data"),
      databasePath: "/var/tmp/musicology-test.sqlite3",
      inputsDirectory: path.join(testRoot, "fixtures/inputs"),
      outputsDirectory: path.join(testRoot, "artifacts"),
    });
    assert.equal(configuration.presentationTimezone, "Europe/Berlin");
    assert.deepEqual(configuration.lastfm, {
      username: "listener",
      apiKey: "test-api-key",
    });
    assert.deepEqual(configurationRedactionValues(configuration), ["test-api-key", "listener"]);
  });

  it("derives default child paths from an overridden data directory", () => {
    const configuration = loadConfiguration({
      environment: { MUSICOLOGY_DATA_DIR: "private-data" },
      repositoryRoot: testRoot,
    });

    assert.equal(configuration.paths.inputsDirectory, path.join(testRoot, "private-data/inputs"));
    assert.equal(
      configuration.paths.databasePath,
      path.join(testRoot, "private-data/database/musicology.sqlite3"),
    );
    assert.equal(configuration.paths.outputsDirectory, path.join(testRoot, "private-data/outputs"));
  });

  it("rejects an invalid timezone without echoing its value", () => {
    const invalidTimezone = "not-a-timezone";

    assert.throws(
      () =>
        loadConfiguration({
          environment: { MUSICOLOGY_TIMEZONE: invalidTimezone },
          repositoryRoot: testRoot,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.issues[0]?.code, "invalid_timezone");
        assert.equal(error.message.includes(invalidTimezone), false);
        return true;
      },
    );
  });

  it("rejects invalid path and secret configuration without exposing supplied values", () => {
    assert.throws(
      () =>
        loadConfiguration({
          environment: { MUSICOLOGY_DATABASE_PATH: "" },
          repositoryRoot: testRoot,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.issues[0]?.code, "invalid_path");
        return true;
      },
    );

    const invalidSecret = "secret-value\n";
    assert.throws(
      () =>
        loadConfiguration({
          environment: { LASTFM_API_KEY: invalidSecret },
          repositoryRoot: testRoot,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.issues[0]?.variable, "LASTFM_API_KEY");
        assert.equal(error.message.includes(invalidSecret), false);
        return true;
      },
    );

    assert.throws(
      () =>
        loadConfiguration({
          environment: { LASTFM_USERNAME: "   " },
          repositoryRoot: testRoot,
        }),
      ConfigurationError,
    );
  });
});
