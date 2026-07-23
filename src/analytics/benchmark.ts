import { performance } from "node:perf_hooks";

import { generateAbandonmentAnalysis } from "./abandonment.ts";
import { generateArtistEraAnalysis } from "./artist-eras.ts";
import { generateRediscoveryAnalysis } from "./rediscovery.ts";
import { generateVolumeAnalysis } from "./volume.ts";
import type { SqliteConnection } from "../db/connection.ts";
import { generateCoverageReport } from "../reporting/coverage.ts";

export const ANALYTICS_BENCHMARK_VERSION = "analytics-benchmark-v1";

export type AnalyticalBenchmarkOperation = "abandonment" | "artist-eras" | "rediscovery" | "volume";

export interface AnalyticalBenchmarkMeasurement {
  readonly elapsedMilliseconds: number;
  readonly eventCount: number;
  readonly operation: AnalyticalBenchmarkOperation;
}

export interface AnalyticalBenchmarkResult {
  readonly canonicalEventCount: number;
  readonly measurements: readonly AnalyticalBenchmarkMeasurement[];
  readonly presentationTimezone: string;
  readonly version: typeof ANALYTICS_BENCHMARK_VERSION;
}

export class AnalyticalBenchmarkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalyticalBenchmarkError";
  }
}

/**
 * Runs every analytical family against one read-only database snapshot and confirms that each
 * analysis has the same canonical population as the aggregate coverage report. Timings are
 * intentionally observational rather than a CI budget because local hardware varies.
 */
export function benchmarkAnalyses(
  connection: SqliteConnection,
  presentationTimezone: string,
  now: () => number = () => performance.now(),
): AnalyticalBenchmarkResult {
  return connection.transaction((snapshotConnection) => {
    const coverage = generateCoverageReport({
      connection: snapshotConnection,
      now: () => 0,
      timezone: presentationTimezone,
    });
    const generators: readonly [
      AnalyticalBenchmarkOperation,
      () => { readonly eventCount: number },
    ][] = [
      [
        "volume",
        () => generateVolumeAnalysis({ connection: snapshotConnection, presentationTimezone }),
      ],
      [
        "artist-eras",
        () => generateArtistEraAnalysis({ connection: snapshotConnection, presentationTimezone }),
      ],
      [
        "rediscovery",
        () => generateRediscoveryAnalysis({ connection: snapshotConnection, presentationTimezone }),
      ],
      [
        "abandonment",
        () => generateAbandonmentAnalysis({ connection: snapshotConnection, presentationTimezone }),
      ],
    ];
    const measurements = generators.map(([operation, generate]) => {
      const startedAt = now();
      const result = generate();
      const elapsedMilliseconds = now() - startedAt;
      if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds < 0) {
        throw new AnalyticalBenchmarkError("Analytical benchmark clock must be monotonic");
      }
      if (result.eventCount !== coverage.canonical.eventCount) {
        throw new AnalyticalBenchmarkError(
          `Analytical ${operation} event count does not reconcile to canonical coverage`,
        );
      }
      return { elapsedMilliseconds, eventCount: result.eventCount, operation };
    });
    return {
      canonicalEventCount: coverage.canonical.eventCount,
      measurements,
      presentationTimezone,
      version: ANALYTICS_BENCHMARK_VERSION,
    };
  }, "deferred");
}
