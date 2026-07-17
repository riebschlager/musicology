import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { projectName } from "../../src/project.ts";

describe("project scaffold", () => {
  it("exports the project name", () => {
    assert.equal(projectName, "musicology");
  });
});
