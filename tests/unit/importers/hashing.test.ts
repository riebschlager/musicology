import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { SupportedSourceType } from "../../../src/importers/contracts.ts";
import {
  fingerprintSourceRecord,
  hashSourceFile,
  isSha256,
} from "../../../src/importers/hashing.ts";

describe("source hashing contracts", () => {
  it("hashes exact source bytes without changing the file", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "musicology-source-hash-"));
    const filePath = path.join(directory, "synthetic.json");
    const contents = Buffer.from('{"track":"Synthetic 🎵"}\n', "utf8");
    writeFileSync(filePath, contents);

    try {
      const hashed = hashSourceFile({
        absolutePath: filePath,
        relativePath: "spotify/synthetic.json",
        sourceType: SupportedSourceType.SpotifyExport,
      });

      assert.equal(hashed.byteSize, contents.byteLength);
      assert.equal(
        hashed.contentSha256,
        "1304905396ee7bbb91d668ed86f9605e004ab09697f358a8489fd737c2df452f",
      );
      assert.equal(isSha256(hashed.contentSha256), true);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it("fingerprints a versioned allowlisted projection independently of field order", () => {
    const first = fingerprintSourceRecord({
      sourceKind: "spotify",
      version: "spotify-source-v1",
      fields: { track: "Synthetic Track", playedMs: 12_345, skipped: false, album: null },
    });
    const reordered = fingerprintSourceRecord({
      sourceKind: "spotify",
      version: "spotify-source-v1",
      fields: { album: null, skipped: false, playedMs: 12_345, track: "Synthetic Track" },
    });
    const revised = fingerprintSourceRecord({
      sourceKind: "spotify",
      version: "spotify-source-v2",
      fields: { album: null, skipped: false, playedMs: 12_345, track: "Synthetic Track" },
    });

    assert.equal(first, reordered);
    assert.notEqual(first, revised);
    assert.equal(isSha256(first), true);
  });

  it("preserves type, null, and exact display-text distinctions", () => {
    const fingerprint = (value: string | boolean | null) =>
      fingerprintSourceRecord({
        sourceKind: "lastfm",
        version: "lastfm-source-v1",
        fields: { value },
      });

    assert.notEqual(fingerprint("false"), fingerprint(false));
    assert.notEqual(fingerprint(""), fingerprint(null));
    assert.notEqual(fingerprint("Beyoncé"), fingerprint("Beyoncé"));
    assert.throws(
      () =>
        fingerprintSourceRecord({
          sourceKind: "lastfm",
          version: "lastfm-source-v1",
          fields: { timestamp: Number.MAX_SAFE_INTEGER + 1 },
        }),
      /safe integer/,
    );
  });
});
