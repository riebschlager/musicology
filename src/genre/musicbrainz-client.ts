import { normalizeMatchText } from "../identity/normalization.ts";
import {
  GENRE_EVIDENCE_CONTRACT_VERSION,
  type GenreEnrichmentErrorCode,
  type GenreEnrichmentSnapshot,
  MUSICBRAINZ_ATTRIBUTION,
  MUSICBRAINZ_LICENSE,
  MUSICBRAINZ_PROVIDER,
  MUSICBRAINZ_RESPONSE_SCHEMA_VERSION,
  validateGenreEnrichmentSnapshot,
} from "./evidence-contract.ts";

export const MUSICBRAINZ_ARTIST_ENDPOINT = "https://musicbrainz.org/ws/2/artist/";
export const MUSICBRAINZ_USER_AGENT =
  "musicology/0.0.0 (https://github.com/riebschlager/musicology)";
export const DEFAULT_MUSICBRAINZ_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_MUSICBRAINZ_MAX_RETRIES = 3;
export const DEFAULT_MUSICBRAINZ_RETRY_BASE_DELAY_MS = 1_000;
export const DEFAULT_MUSICBRAINZ_RETRY_MAX_DELAY_MS = 30_000;
export const DEFAULT_MUSICBRAINZ_RATE_LIMIT_INTERVAL_MS = 1_000;
export const DEFAULT_GENRE_ENRICHMENT_REFRESH_AGE_MS = 180 * 24 * 60 * 60 * 1_000;

export interface MusicbrainzClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface MusicbrainzHttpRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly url: string;
}

export interface MusicbrainzHttpResponse {
  readonly headers?: Readonly<Record<string, string>>;
  readonly status: number;
  text(): Promise<string>;
}

/** Injectable HTTP boundary; production uses the platform fetch implementation. */
export interface MusicbrainzHttpTransport {
  request(request: MusicbrainzHttpRequest): Promise<MusicbrainzHttpResponse>;
}

/** One canonical artist can only be fetched when its exact strong MusicBrainz ID is known. */
export interface MusicbrainzEnrichmentTarget {
  readonly artistId: number;
  readonly musicbrainzArtistId?: string;
}

export interface CachedGenreEnrichmentSnapshot {
  readonly snapshot: GenreEnrichmentSnapshot;
  readonly snapshotId: number;
}

/**
 * Persistence is intentionally a narrow boundary. P5-04 supplies the SQLite implementation;
 * this client can be tested with a deterministic in-memory cache without accepting raw payloads.
 */
export interface GenreEnrichmentSnapshotCache {
  latest(target: MusicbrainzEnrichmentTarget): Promise<CachedGenreEnrichmentSnapshot | undefined>;
  record(snapshot: GenreEnrichmentSnapshot): Promise<CachedGenreEnrichmentSnapshot>;
}

export interface MusicbrainzClientOptions {
  readonly clock?: MusicbrainzClock;
  readonly maxRetries?: number;
  readonly rateLimitIntervalMs?: number;
  readonly refreshAgeMs?: number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly transport?: MusicbrainzHttpTransport;
  readonly userAgent?: string;
}

export interface EnrichMusicbrainzArtistsOptions {
  readonly dryRun?: boolean;
  readonly limit?: number;
  /** Refreshes only success/negative snapshots at or beyond the configured refresh age. */
  readonly refresh?: boolean;
}

export type MusicbrainzEnrichmentAction = "cached" | "fetched" | "skipped";

export interface MusicbrainzEnrichmentResult {
  readonly action: MusicbrainzEnrichmentAction;
  readonly artistId: number;
  readonly reason?: "ambiguous_identity" | "limit_reached";
  readonly snapshot?: GenreEnrichmentSnapshot;
}

export const MusicbrainzClientErrorCategory = {
  Http: "http",
  InvalidRequest: "invalid_request",
  InvalidResponse: "invalid_response",
  RateLimit: "rate_limit",
  Timeout: "timeout",
  Transport: "transport",
} as const;

export type MusicbrainzClientErrorCategory =
  (typeof MusicbrainzClientErrorCategory)[keyof typeof MusicbrainzClientErrorCategory];

/** A deliberately safe error: it contains no request URL, remote body, or configuration value. */
export class MusicbrainzClientError extends Error {
  readonly category: MusicbrainzClientErrorCategory;
  readonly httpStatus: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    category: MusicbrainzClientErrorCategory,
    retryAfterMs?: number,
    httpStatus?: number,
  ) {
    super(musicbrainzErrorSummary(category));
    this.name = "MusicbrainzClientError";
    this.category = category;
    this.httpStatus = httpStatus;
    this.retryAfterMs = retryAfterMs;
  }
}

const systemClock: MusicbrainzClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const fetchTransport: MusicbrainzHttpTransport = {
  async request(request): Promise<MusicbrainzHttpResponse> {
    const response = await fetch(request.url, { headers: request.headers, signal: request.signal });
    return {
      headers: Object.fromEntries(response.headers.entries()),
      status: response.status,
      text: () => response.text(),
    };
  },
};

export class MusicbrainzGenreClient {
  private readonly clock: MusicbrainzClock;
  private readonly maxRetries: number;
  private readonly rateLimitIntervalMs: number;
  private readonly refreshAgeMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly transport: MusicbrainzHttpTransport;
  private readonly userAgent: string;
  private lastRequestStartedAtEpochMs: number | undefined;

  constructor(options: MusicbrainzClientOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.maxRetries = options.maxRetries ?? DEFAULT_MUSICBRAINZ_MAX_RETRIES;
    this.rateLimitIntervalMs =
      options.rateLimitIntervalMs ?? DEFAULT_MUSICBRAINZ_RATE_LIMIT_INTERVAL_MS;
    this.refreshAgeMs = options.refreshAgeMs ?? DEFAULT_GENRE_ENRICHMENT_REFRESH_AGE_MS;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_MUSICBRAINZ_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_MUSICBRAINZ_RETRY_MAX_DELAY_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_MUSICBRAINZ_REQUEST_TIMEOUT_MS;
    this.transport = options.transport ?? fetchTransport;
    this.userAgent = options.userAgent ?? MUSICBRAINZ_USER_AGENT;
    this.sleep =
      options.sleep ??
      ((delayMs) => new Promise<void>((resolve) => this.clock.setTimeout(resolve, delayMs)));

    if (
      !isNonNegativeSafeInteger(this.maxRetries) ||
      !isPositiveSafeInteger(this.rateLimitIntervalMs) ||
      !isPositiveSafeInteger(this.refreshAgeMs) ||
      !isPositiveSafeInteger(this.retryBaseDelayMs) ||
      !isPositiveSafeInteger(this.retryMaxDelayMs) ||
      this.retryMaxDelayMs < this.retryBaseDelayMs ||
      !isPositiveSafeInteger(this.timeoutMs) ||
      !isNonBlankSafeText(this.userAgent)
    ) {
      throw new MusicbrainzClientError(MusicbrainzClientErrorCategory.InvalidRequest);
    }
  }

  /** Fetches and allowlist-projects one exact MusicBrainz artist result. */
  async fetchArtist(
    target: Required<MusicbrainzEnrichmentTarget>,
  ): Promise<GenreEnrichmentSnapshot> {
    validateTarget(target);
    for (let retry = 0; ; retry += 1) {
      try {
        return await this.fetchArtistAttempt(target);
      } catch (error) {
        if (!(error instanceof MusicbrainzClientError) || !isRetryable(error)) throw error;
        if (retry >= this.maxRetries) {
          return failureSnapshot(target, this.clock.now(), retryExhaustionCode(error));
        }
        await this.sleep(retryDelayMs(error, retry, this.retryBaseDelayMs, this.retryMaxDelayMs));
      }
    }
  }

  /**
   * Processes targets in input order and records each normalized result before moving to the next.
   * Re-running after interruption reads those recorded snapshots and avoids duplicate requests.
   */
  async *enrichArtists(
    targets: Iterable<MusicbrainzEnrichmentTarget>,
    cache: GenreEnrichmentSnapshotCache,
    options: EnrichMusicbrainzArtistsOptions = {},
  ): AsyncGenerator<MusicbrainzEnrichmentResult> {
    if (options.limit !== undefined && !isPositiveSafeInteger(options.limit)) {
      throw new MusicbrainzClientError(MusicbrainzClientErrorCategory.InvalidRequest);
    }
    let processed = 0;
    for (const target of targets) {
      if (options.limit !== undefined && processed >= options.limit) {
        yield { action: "skipped", artistId: target.artistId, reason: "limit_reached" };
        continue;
      }
      processed += 1;
      if (!hasExactMusicbrainzArtistId(target)) {
        yield { action: "skipped", artistId: target.artistId, reason: "ambiguous_identity" };
        continue;
      }

      const cached = await cache.latest(target);
      if (
        cached !== undefined &&
        !shouldRefresh(
          cached.snapshot,
          options.refresh ?? false,
          this.clock.now(),
          this.refreshAgeMs,
        )
      ) {
        yield { action: "cached", artistId: target.artistId, snapshot: cached.snapshot };
        continue;
      }

      const snapshot = await this.fetchArtist({
        artistId: target.artistId,
        musicbrainzArtistId: target.musicbrainzArtistId,
      });
      if (options.dryRun ?? false) {
        yield { action: "fetched", artistId: target.artistId, snapshot };
        continue;
      }
      const stored = await cache.record({
        ...snapshot,
        supersedesSnapshotId:
          snapshot.cacheState === "failure" ? null : (cached?.snapshotId ?? null),
      });
      yield { action: "fetched", artistId: target.artistId, snapshot: stored.snapshot };
    }
  }

  private async fetchArtistAttempt(
    target: Required<MusicbrainzEnrichmentTarget>,
  ): Promise<GenreEnrichmentSnapshot> {
    await this.observeRateLimit();
    const controller = new AbortController();
    const timeout = this.clock.setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: MusicbrainzHttpResponse;
      try {
        response = await this.transport.request({
          url: musicbrainzArtistUrl(target.musicbrainzArtistId),
          headers: { Accept: "application/json", "User-Agent": this.userAgent },
          signal: controller.signal,
        });
      } catch {
        throw new MusicbrainzClientError(
          controller.signal.aborted
            ? MusicbrainzClientErrorCategory.Timeout
            : MusicbrainzClientErrorCategory.Transport,
        );
      }
      if (response.status === 404) return notFoundSnapshot(target, this.clock.now());
      if (response.status === 429) {
        throw new MusicbrainzClientError(
          MusicbrainzClientErrorCategory.RateLimit,
          retryAfterMs(response.headers, this.clock.now()),
        );
      }
      if (
        !Number.isSafeInteger(response.status) ||
        response.status < 200 ||
        response.status >= 300
      ) {
        throw new MusicbrainzClientError(
          MusicbrainzClientErrorCategory.Http,
          undefined,
          response.status,
        );
      }
      let payload: unknown;
      try {
        payload = JSON.parse(await response.text()) as unknown;
      } catch {
        throw new MusicbrainzClientError(
          controller.signal.aborted
            ? MusicbrainzClientErrorCategory.Timeout
            : MusicbrainzClientErrorCategory.InvalidResponse,
        );
      }
      return successfulSnapshot(
        target,
        this.clock.now(),
        parseArtistPayload(payload, target.musicbrainzArtistId),
      );
    } catch (error) {
      if (
        error instanceof MusicbrainzClientError &&
        error.category === MusicbrainzClientErrorCategory.InvalidResponse
      ) {
        return failureSnapshot(
          target,
          this.clock.now(),
          "malformed_response",
          "malformed_response",
        );
      }
      throw error;
    } finally {
      this.clock.clearTimeout(timeout);
    }
  }

  private async observeRateLimit(): Promise<void> {
    const now = this.clock.now();
    if (this.lastRequestStartedAtEpochMs !== undefined) {
      const wait = this.rateLimitIntervalMs - (now - this.lastRequestStartedAtEpochMs);
      if (wait > 0) await this.sleep(wait);
    }
    this.lastRequestStartedAtEpochMs = this.clock.now();
  }
}

export function musicbrainzArtistUrl(musicbrainzArtistId: string): string {
  if (!isNonBlankSafeText(musicbrainzArtistId)) {
    throw new MusicbrainzClientError(MusicbrainzClientErrorCategory.InvalidRequest);
  }
  const parameters = new URLSearchParams({ fmt: "json", inc: "genres+tags" });
  return `${MUSICBRAINZ_ARTIST_ENDPOINT}${encodeURIComponent(musicbrainzArtistId)}?${parameters.toString()}`;
}

function parseArtistPayload(
  payload: unknown,
  expectedMusicbrainzArtistId: string,
): GenreEnrichmentSnapshot["rawTags"] {
  if (!isObject(payload) || payload.id !== expectedMusicbrainzArtistId) {
    throw new MusicbrainzClientError(MusicbrainzClientErrorCategory.InvalidResponse);
  }
  const tags = parseTags(payload.tags, false);
  const genres = parseTags(payload.genres, true);
  const byNormalizedTag = new Map<string, GenreEnrichmentSnapshot["rawTags"][number]>();
  for (const tag of tags) {
    const existing = byNormalizedTag.get(tag.normalizedRawTag);
    if (existing === undefined) {
      byNormalizedTag.set(tag.normalizedRawTag, tag);
    } else {
      throw new MusicbrainzClientError(MusicbrainzClientErrorCategory.InvalidResponse);
    }
  }
  for (const genre of genres) {
    const existing = byNormalizedTag.get(genre.normalizedRawTag);
    if (existing?.isRecognizedGenre) {
      throw new MusicbrainzClientError(MusicbrainzClientErrorCategory.InvalidResponse);
    }
    // MusicBrainz may return the same normalized value in both `tags` and `genres` with
    // different presentation text or vote counts. The recognized-genre representation is the
    // deterministic authoritative row because this contract permits one normalized tag per
    // snapshot while preserving the provider's recognized-genre classification.
    byNormalizedTag.set(genre.normalizedRawTag, genre);
  }
  return [...byNormalizedTag.values()];
}

function parseTags(value: unknown, isRecognizedGenre: boolean): GenreEnrichmentSnapshot["rawTags"] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new MusicbrainzClientError(MusicbrainzClientErrorCategory.InvalidResponse);
  return value.map((item) => {
    if (
      !isObject(item) ||
      typeof item.name !== "string" ||
      !isNonBlankSafeText(item.name) ||
      !isNonNegativeFiniteNumber(item.count)
    ) {
      throw new MusicbrainzClientError(MusicbrainzClientErrorCategory.InvalidResponse);
    }
    const normalizedRawTag = normalizeMatchText(item.name);
    if (normalizedRawTag === null)
      throw new MusicbrainzClientError(MusicbrainzClientErrorCategory.InvalidResponse);
    return {
      rawTagName: item.name,
      normalizedRawTag,
      rawWeight: item.count,
      confidence: null,
      isRecognizedGenre,
    };
  });
}

function successfulSnapshot(
  target: Required<MusicbrainzEnrichmentTarget>,
  fetchedAtEpochMs: number,
  rawTags: GenreEnrichmentSnapshot["rawTags"],
): GenreEnrichmentSnapshot {
  const snapshot: GenreEnrichmentSnapshot = {
    ...snapshotBase(target, fetchedAtEpochMs),
    cacheState: rawTags.length === 0 ? "negative" : "success",
    outcome: rawTags.length === 0 ? "no_tags" : "success",
    errorCode: null,
    supersedesSnapshotId: null,
    rawTags,
  };
  validateGenreEnrichmentSnapshot(snapshot);
  return snapshot;
}

function notFoundSnapshot(
  target: Required<MusicbrainzEnrichmentTarget>,
  fetchedAtEpochMs: number,
): GenreEnrichmentSnapshot {
  const snapshot: GenreEnrichmentSnapshot = {
    ...snapshotBase(target, fetchedAtEpochMs),
    cacheState: "negative",
    outcome: "not_found",
    errorCode: "not_found",
    supersedesSnapshotId: null,
    rawTags: [],
  };
  validateGenreEnrichmentSnapshot(snapshot);
  return snapshot;
}

function failureSnapshot(
  target: Required<MusicbrainzEnrichmentTarget>,
  fetchedAtEpochMs: number,
  errorCode: GenreEnrichmentErrorCode,
  outcome: "temporary_failure" | "malformed_response" = "temporary_failure",
): GenreEnrichmentSnapshot {
  const snapshot: GenreEnrichmentSnapshot = {
    ...snapshotBase(target, fetchedAtEpochMs),
    cacheState: "failure",
    outcome,
    errorCode,
    supersedesSnapshotId: null,
    rawTags: [],
  };
  validateGenreEnrichmentSnapshot(snapshot);
  return snapshot;
}

function snapshotBase(target: Required<MusicbrainzEnrichmentTarget>, fetchedAtEpochMs: number) {
  return {
    artistId: target.artistId,
    provider: MUSICBRAINZ_PROVIDER,
    providerEntityId: target.musicbrainzArtistId,
    providerResponseSchemaVersion: MUSICBRAINZ_RESPONSE_SCHEMA_VERSION,
    contractVersion: GENRE_EVIDENCE_CONTRACT_VERSION,
    providerLicense: MUSICBRAINZ_LICENSE,
    providerAttribution: MUSICBRAINZ_ATTRIBUTION,
    fetchedAtEpochMs,
  } as const;
}

function shouldRefresh(
  snapshot: GenreEnrichmentSnapshot,
  refresh: boolean,
  now: number,
  refreshAgeMs: number,
): boolean {
  if (snapshot.cacheState === "failure") return true;
  return refresh && now - snapshot.fetchedAtEpochMs >= refreshAgeMs;
}

function hasExactMusicbrainzArtistId(
  target: MusicbrainzEnrichmentTarget,
): target is Required<MusicbrainzEnrichmentTarget> {
  return (
    isNonBlankSafeText(target.musicbrainzArtistId ?? "") && isPositiveSafeInteger(target.artistId)
  );
}

function validateTarget(target: Required<MusicbrainzEnrichmentTarget>): void {
  if (!hasExactMusicbrainzArtistId(target)) {
    throw new MusicbrainzClientError(MusicbrainzClientErrorCategory.InvalidRequest);
  }
}

function isRetryable(error: MusicbrainzClientError): boolean {
  return (
    error.category === MusicbrainzClientErrorCategory.RateLimit ||
    error.category === MusicbrainzClientErrorCategory.Timeout ||
    error.category === MusicbrainzClientErrorCategory.Transport ||
    (error.category === MusicbrainzClientErrorCategory.Http &&
      (error.httpStatus === 408 ||
        error.httpStatus === 425 ||
        error.httpStatus === 500 ||
        error.httpStatus === 502 ||
        error.httpStatus === 503 ||
        error.httpStatus === 504))
  );
}

function retryExhaustionCode(error: MusicbrainzClientError): GenreEnrichmentErrorCode {
  if (error.category === MusicbrainzClientErrorCategory.RateLimit) return "rate_limited";
  if (error.category === MusicbrainzClientErrorCategory.Timeout) return "timeout";
  return "retry_exhausted";
}

function retryDelayMs(
  error: MusicbrainzClientError,
  retry: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** retry);
  return Math.max(error.retryAfterMs ?? 0, exponential);
}

function retryAfterMs(
  headers: Readonly<Record<string, string>> | undefined,
  now: number,
): number | undefined {
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (raw === undefined) return undefined;
  if (/^\d+$/u.test(raw)) return Number(raw) * 1_000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankSafeText(value: string): boolean {
  return value.trim() !== "" && !/\p{Cc}/u.test(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function musicbrainzErrorSummary(category: MusicbrainzClientErrorCategory): string {
  switch (category) {
    case MusicbrainzClientErrorCategory.Http:
      return "MusicBrainz returned an unsuccessful HTTP response";
    case MusicbrainzClientErrorCategory.InvalidRequest:
      return "MusicBrainz enrichment request is invalid";
    case MusicbrainzClientErrorCategory.InvalidResponse:
      return "MusicBrainz enrichment response is invalid";
    case MusicbrainzClientErrorCategory.RateLimit:
      return "MusicBrainz enrichment rate limit was reached";
    case MusicbrainzClientErrorCategory.Timeout:
      return "MusicBrainz enrichment request timed out";
    case MusicbrainzClientErrorCategory.Transport:
      return "MusicBrainz enrichment request failed";
  }
}
