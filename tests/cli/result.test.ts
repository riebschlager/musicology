import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ExitCode,
  commandFailure,
  commandSuccess,
  redactSensitiveText,
  renderCommandResult,
} from "../../src/cli/result.ts";

describe("CLI command result contract", () => {
  it("renders a machine-readable JSON summary", () => {
    const result = commandSuccess("validate", "Validation passed", {
      accepted: 12,
      rejected: 0,
    });

    assert.deepEqual(JSON.parse(renderCommandResult(result, { format: "json" })), {
      command: "validate",
      status: "success",
      exitCode: 0,
      summary: "Validation passed",
      data: { accepted: 12, rejected: 0 },
    });
  });

  it("renders concise human-readable success and failure summaries", () => {
    const success = commandSuccess("validate", "Validation passed");
    const failure = commandFailure("validate", ExitCode.DataError, "Validation failed", [
      { code: "invalid_record", message: "One record was invalid" },
    ]);

    assert.equal(renderCommandResult(success), "Validation passed\n");
    assert.equal(
      renderCommandResult(failure),
      "Validation failed\nError [invalid_record]: One record was invalid\n",
    );
  });

  it("defines stable exit-code categories", () => {
    assert.deepEqual(ExitCode, {
      Success: 0,
      InternalError: 1,
      UsageError: 2,
      ConfigurationError: 3,
      DataError: 4,
    });
    assert.equal(commandSuccess("test", "ok").exitCode, ExitCode.Success);
    assert.equal(
      commandFailure("test", ExitCode.ConfigurationError, "bad config", []).exitCode,
      ExitCode.ConfigurationError,
    );
  });

  it("redacts every configured sensitive value from human and JSON output", () => {
    const apiKey = "api-key-123";
    const username = "private-listener";
    const result = commandFailure(
      "sync:lastfm",
      ExitCode.ConfigurationError,
      `Could not sync ${username}`,
      [{ code: "request_failed", message: `Request used ${apiKey}` }],
    );
    const sensitiveValues = [apiKey, username];

    const human = renderCommandResult(result, { sensitiveValues });
    const json = renderCommandResult(result, { format: "json", sensitiveValues });

    for (const output of [human, json]) {
      assert.equal(output.includes(apiKey), false);
      assert.equal(output.includes(username), false);
      assert.match(output, /\[REDACTED\]/);
    }
    assert.doesNotThrow(() => JSON.parse(json));
    assert.equal(redactSensitiveText("unchanged", []), "unchanged");
  });
});
