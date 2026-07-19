import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import type {
  DiscoveredSourceFile,
  HashedSourceFile,
  SourceFingerprintValue,
} from "./contracts.ts";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const HASH_BUFFER_BYTES = 64 * 1024;

export function isSha256(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

/** Hashes exact file bytes without interpreting, normalizing, or rewriting the source file. */
export function hashSourceFile(file: DiscoveredSourceFile): HashedSourceFile {
  const descriptor = openSync(file.absolutePath, "r");
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new Error("Source path must identify a regular file");
    }

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let bytesRead: number;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);

    return {
      ...file,
      byteSize: stats.size,
      contentSha256: hash.digest("hex"),
    };
  } finally {
    closeSync(descriptor);
  }
}

function validateFingerprintValue(name: string, value: SourceFingerprintValue): void {
  if (name.length === 0) {
    throw new Error("Source fingerprint field names must not be empty");
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error(`Source fingerprint field ${name} must be a safe integer`);
  }
}

function taggedValue(value: SourceFingerprintValue): readonly [string, SourceFingerprintValue] {
  if (value === null) {
    return ["null", value];
  }
  return [typeof value, value];
}

export interface SourceFingerprintInput {
  readonly fields: Readonly<Record<string, SourceFingerprintValue>>;
  readonly sourceKind: "lastfm" | "spotify";
  readonly version: string;
}

/**
 * Fingerprints only the caller's approved record projection. File hashes identify exact input
 * bytes; source fingerprints identify versioned record semantics and must never receive raw data.
 */
export function fingerprintSourceRecord(input: SourceFingerprintInput): string {
  if (input.version.length === 0) {
    throw new Error("Source fingerprint version must not be empty");
  }

  const fields = Object.entries(input.fields)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => {
      validateFingerprintValue(name, value);
      return [name, ...taggedValue(value)] as const;
    });
  const canonical = JSON.stringify({
    fields,
    sourceKind: input.sourceKind,
    version: input.version,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
