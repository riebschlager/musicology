import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

import {
  type DiscoveredSourceFile,
  type SupportedSourceDiscovery,
  SupportedSourceType,
} from "../contracts.ts";

const SPOTIFY_AUDIO_EXPORT_FILENAME = /^Streaming_History_Audio_\d{4}(?:-\d{4})?_\d+\.json$/;

function isRegularFileInsideRoot(candidatePath: string, evidenceRoot: string): boolean {
  try {
    if (!lstatSync(candidatePath).isFile()) {
      return false;
    }
    const resolvedRoot = realpathSync.native(evidenceRoot);
    const resolvedCandidate = realpathSync.native(candidatePath);
    return repositoryRelativePath(resolvedCandidate, resolvedRoot) !== undefined;
  } catch {
    return false;
  }
}

function repositoryRelativePath(absolutePath: string, evidenceRoot: string): string | undefined {
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

/**
 * Positively identifies the documented Spotify extended-history audio filename family. Candidate
 * directories, symlinks, video-history files, and arbitrary JSON are not discovered.
 */
export class SpotifyAudioExportDiscovery implements SupportedSourceDiscovery {
  readonly #evidenceRoot: string;

  constructor(evidenceRoot: string) {
    this.#evidenceRoot = path.resolve(evidenceRoot);
  }

  discover(candidatePaths: readonly string[]): readonly DiscoveredSourceFile[] {
    const discovered = new Map<string, DiscoveredSourceFile>();

    for (const candidatePath of candidatePaths) {
      const absolutePath = path.resolve(this.#evidenceRoot, candidatePath);
      const relativePath = repositoryRelativePath(absolutePath, this.#evidenceRoot);
      if (
        relativePath === undefined ||
        !SPOTIFY_AUDIO_EXPORT_FILENAME.test(path.basename(absolutePath)) ||
        !isRegularFileInsideRoot(absolutePath, this.#evidenceRoot)
      ) {
        continue;
      }

      discovered.set(absolutePath, {
        absolutePath,
        relativePath,
        sourceType: SupportedSourceType.SpotifyExport,
      });
    }

    return [...discovered.values()].sort((left, right) =>
      left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
    );
  }
}
