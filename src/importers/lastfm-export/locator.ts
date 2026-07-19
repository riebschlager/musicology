import { createHash } from "node:crypto";
import { type Dirent, readdirSync } from "node:fs";
import path from "node:path";

export const LASTFM_EVIDENCE_LOCATOR_VERSION = "lastfm-path-v1";

/** Returns a stable path locator without persisting an arbitrary private export filename. */
export function lastfmEvidenceLocator(relativePath: string): string {
  const pathHash = createHash("sha256")
    .update(`${LASTFM_EVIDENCE_LOCATOR_VERSION}\0${relativePath}`, "utf8")
    .digest("hex");
  return `lastfm/path-${pathHash}.json`;
}

/** Resolves an opaque stored locator against direct JSON children of the private Last.fm input. */
export function resolveLastfmEvidenceLocator(
  evidenceRoot: string,
  storedLocator: string,
): string | undefined {
  const lastfmDirectory = path.join(evidenceRoot, "lastfm");
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(lastfmDirectory, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name) !== ".json") {
      continue;
    }
    const relativePath = `lastfm/${entry.name}`;
    if (lastfmEvidenceLocator(relativePath) === storedLocator) {
      return path.join(lastfmDirectory, entry.name);
    }
  }
  return undefined;
}
