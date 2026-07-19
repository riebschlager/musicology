import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

import {
  type DiscoveredSourceFile,
  type SupportedSourceDiscovery,
  SupportedSourceType,
} from "../contracts.ts";

function evidenceRelativePath(absolutePath: string, evidenceRoot: string): string | undefined {
  const relativePath = path.relative(evidenceRoot, absolutePath);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return undefined;
  }
  return relativePath.split(path.sep).join("/");
}

function isRegularFileInsideRoot(candidatePath: string, evidenceRoot: string): boolean {
  try {
    if (!lstatSync(candidatePath).isFile()) {
      return false;
    }
    const resolvedRoot = realpathSync.native(evidenceRoot);
    const resolvedCandidate = realpathSync.native(candidatePath);
    return evidenceRelativePath(resolvedCandidate, resolvedRoot) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Discovers explicit JSON export files directly inside the dedicated `lastfm` evidence directory.
 * The directory is the source declaration because Last.fm has no official export filename family.
 */
export class LastfmExportDiscovery implements SupportedSourceDiscovery {
  readonly #evidenceRoot: string;
  readonly #lastfmDirectory: string;

  constructor(evidenceRoot: string) {
    this.#evidenceRoot = path.resolve(evidenceRoot);
    this.#lastfmDirectory = path.join(this.#evidenceRoot, "lastfm");
  }

  discover(candidatePaths: readonly string[]): readonly DiscoveredSourceFile[] {
    const discovered = new Map<string, DiscoveredSourceFile>();

    for (const candidatePath of candidatePaths) {
      const absolutePath = path.resolve(this.#evidenceRoot, candidatePath);
      const relativePath = evidenceRelativePath(absolutePath, this.#evidenceRoot);
      if (
        relativePath === undefined ||
        path.dirname(absolutePath) !== this.#lastfmDirectory ||
        path.extname(absolutePath) !== ".json" ||
        !isRegularFileInsideRoot(absolutePath, this.#evidenceRoot)
      ) {
        continue;
      }

      discovered.set(absolutePath, {
        absolutePath,
        relativePath,
        sourceType: SupportedSourceType.LastfmExport,
      });
    }

    return [...discovered.values()].sort((left, right) =>
      left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
    );
  }
}
