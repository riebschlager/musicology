const LASTFM_RECENT_TRACKS_ENDPOINT = "https://ws.audioscrobbler.com/2.0/";

export const LASTFM_USER_AGENT = "musicology/0.0.0 (local-first music history client)";
export const DEFAULT_LASTFM_REQUEST_TIMEOUT_MS = 15_000;

export interface LastfmClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LastfmHttpRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly url: string;
}

export interface LastfmHttpResponse {
  readonly status: number;
  text(): Promise<string>;
}

/** Injectable HTTP boundary; production uses the platform fetch implementation. */
export interface LastfmHttpTransport {
  request(request: LastfmHttpRequest): Promise<LastfmHttpResponse>;
}

export interface LastfmClientConfiguration {
  readonly apiKey: string;
  readonly username: string;
}

export interface LastfmRecentTracksRequest {
  readonly fromEpochMs: number;
  readonly limit?: number;
  readonly page?: number;
  readonly toEpochMs?: number;
}

export interface LastfmCompletedTrack {
  readonly albumName: string | null;
  readonly artistMusicbrainzId: string | null;
  readonly artistName: string;
  readonly loved: boolean | null;
  readonly recordingMusicbrainzId: string | null;
  readonly releaseMusicbrainzId: string | null;
  readonly scrobbledAtEpochMs: number;
  readonly trackName: string;
}

export interface LastfmPaginationMetadata {
  readonly page: number;
  readonly perPage: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface LastfmRecentTracksPage {
  readonly completedTracks: readonly LastfmCompletedTrack[];
  readonly ignoredNowPlayingCount: number;
  readonly pagination: LastfmPaginationMetadata;
}

export const LastfmClientErrorCategory = {
  Api: "api",
  Http: "http",
  InvalidRequest: "invalid_request",
  InvalidResponse: "invalid_response",
  Timeout: "timeout",
  Transport: "transport",
} as const;

export type LastfmClientErrorCategory =
  (typeof LastfmClientErrorCategory)[keyof typeof LastfmClientErrorCategory];

/** A deliberately safe error: it contains neither request URLs nor remote response text. */
export class LastfmClientError extends Error {
  readonly apiCode: number | undefined;
  readonly category: LastfmClientErrorCategory;
  readonly httpStatus: number | undefined;

  constructor(
    category: LastfmClientErrorCategory,
    options: { readonly apiCode?: number; readonly httpStatus?: number } = {},
  ) {
    super(lastfmClientErrorSummary(category));
    this.name = "LastfmClientError";
    this.category = category;
    this.apiCode = options.apiCode;
    this.httpStatus = options.httpStatus;
  }
}

export interface LastfmClientOptions {
  readonly clock?: LastfmClock;
  readonly timeoutMs?: number;
  readonly transport?: LastfmHttpTransport;
  readonly userAgent?: string;
}

const systemClock: LastfmClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const fetchTransport: LastfmHttpTransport = {
  async request(request): Promise<LastfmHttpResponse> {
    const response = await fetch(request.url, {
      headers: request.headers,
      signal: request.signal,
    });
    return response;
  },
};

export class LastfmClient {
  private readonly clock: LastfmClock;
  private readonly configuration: LastfmClientConfiguration;
  private readonly timeoutMs: number;
  private readonly transport: LastfmHttpTransport;
  private readonly userAgent: string;

  constructor(configuration: LastfmClientConfiguration, options: LastfmClientOptions = {}) {
    if (!isNonBlankSafeText(configuration.apiKey) || !isNonBlankSafeText(configuration.username)) {
      throw new LastfmClientError(LastfmClientErrorCategory.InvalidRequest);
    }

    this.configuration = configuration;
    this.clock = options.clock ?? systemClock;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LASTFM_REQUEST_TIMEOUT_MS;
    this.transport = options.transport ?? fetchTransport;
    this.userAgent = options.userAgent ?? LASTFM_USER_AGENT;

    if (!isPositiveSafeInteger(this.timeoutMs) || !isNonBlankSafeText(this.userAgent)) {
      throw new LastfmClientError(LastfmClientErrorCategory.InvalidRequest);
    }
  }

  async getRecentTracksPage(request: LastfmRecentTracksRequest): Promise<LastfmRecentTracksPage> {
    const parameters = recentTracksParameters(this.configuration, request);
    const controller = new AbortController();
    const timeout = this.clock.setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      let response: LastfmHttpResponse;
      try {
        response = await this.transport.request({
          url: `${LASTFM_RECENT_TRACKS_ENDPOINT}?${parameters.toString()}`,
          headers: { Accept: "application/json", "User-Agent": this.userAgent },
          signal: controller.signal,
        });
      } catch {
        throw new LastfmClientError(
          controller.signal.aborted
            ? LastfmClientErrorCategory.Timeout
            : LastfmClientErrorCategory.Transport,
        );
      }

      if (
        !Number.isSafeInteger(response.status) ||
        response.status < 200 ||
        response.status >= 300
      ) {
        throw new LastfmClientError(LastfmClientErrorCategory.Http, {
          httpStatus: response.status,
        });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(await response.text()) as unknown;
      } catch {
        throw new LastfmClientError(
          controller.signal.aborted
            ? LastfmClientErrorCategory.Timeout
            : LastfmClientErrorCategory.InvalidResponse,
        );
      }
      return parseRecentTracksPayload(payload);
    } finally {
      this.clock.clearTimeout(timeout);
    }
  }
}

/** Converts the canonical UTC instant representation to Last.fm's inclusive Unix-second boundary. */
export function serializeLastfmUtcBoundary(epochMs: number): string {
  if (!isNonNegativeSafeInteger(epochMs)) {
    throw new LastfmClientError(LastfmClientErrorCategory.InvalidRequest);
  }
  return String(Math.floor(epochMs / 1_000));
}

function recentTracksParameters(
  configuration: LastfmClientConfiguration,
  request: LastfmRecentTracksRequest,
): URLSearchParams {
  const from = serializeLastfmUtcBoundary(request.fromEpochMs);
  const to =
    request.toEpochMs === undefined ? undefined : serializeLastfmUtcBoundary(request.toEpochMs);
  const page = request.page ?? 1;
  const limit = request.limit ?? 200;
  if (
    !isPositiveSafeInteger(page) ||
    !isPositiveSafeInteger(limit) ||
    limit > 200 ||
    (to !== undefined && request.toEpochMs !== undefined && request.toEpochMs < request.fromEpochMs)
  ) {
    throw new LastfmClientError(LastfmClientErrorCategory.InvalidRequest);
  }

  const parameters = new URLSearchParams({
    api_key: configuration.apiKey,
    format: "json",
    from,
    limit: String(limit),
    method: "user.getRecentTracks",
    page: String(page),
    user: configuration.username,
  });
  if (to !== undefined) parameters.set("to", to);
  return parameters;
}

function parseRecentTracksPayload(payload: unknown): LastfmRecentTracksPage {
  if (!isObject(payload)) throw new LastfmClientError(LastfmClientErrorCategory.InvalidResponse);
  const apiError = parseApiError(payload);
  if (apiError !== undefined) {
    throw new LastfmClientError(LastfmClientErrorCategory.Api, { apiCode: apiError });
  }

  const recentTracks = payload.recenttracks;
  if (!isObject(recentTracks) || !Array.isArray(recentTracks.track)) {
    throw new LastfmClientError(LastfmClientErrorCategory.InvalidResponse);
  }
  const pagination = parsePagination(recentTracks["@attr"]);
  if (recentTracks.track.length > pagination.perPage) {
    throw new LastfmClientError(LastfmClientErrorCategory.InvalidResponse);
  }

  const completedTracks: LastfmCompletedTrack[] = [];
  let ignoredNowPlayingCount = 0;
  for (const track of recentTracks.track) {
    const parsed = parseTrack(track);
    if (parsed === "now_playing") {
      ignoredNowPlayingCount += 1;
    } else {
      completedTracks.push(parsed);
    }
  }
  return { completedTracks, ignoredNowPlayingCount, pagination };
}

function parseApiError(payload: Readonly<Record<string, unknown>>): number | undefined {
  if (payload.error === undefined) return undefined;
  return parseInteger(payload.error, 0, Number.MAX_SAFE_INTEGER);
}

function parsePagination(value: unknown): LastfmPaginationMetadata {
  if (!isObject(value)) throw new LastfmClientError(LastfmClientErrorCategory.InvalidResponse);
  const pagination = {
    page: parseInteger(value.page, 1, Number.MAX_SAFE_INTEGER),
    perPage: parseInteger(value.perPage, 1, 200),
    total: parseInteger(value.total, 0, Number.MAX_SAFE_INTEGER),
    totalPages: parseInteger(value.totalPages, 0, Number.MAX_SAFE_INTEGER),
  };
  const expectedTotalPages = Math.ceil(pagination.total / pagination.perPage);
  if (
    pagination.totalPages !== expectedTotalPages ||
    (pagination.totalPages > 0 && pagination.page > pagination.totalPages) ||
    (pagination.totalPages === 0 && pagination.page !== 1)
  ) {
    throw new LastfmClientError(LastfmClientErrorCategory.InvalidResponse);
  }
  return pagination;
}

function parseTrack(value: unknown): LastfmCompletedTrack | "now_playing" {
  if (!isObject(value)) throw new LastfmClientError(LastfmClientErrorCategory.InvalidResponse);
  const attributes = value["@attr"];
  if (isObject(attributes) && attributes.nowplaying === "true") return "now_playing";

  const artist = parseTextField(value.artist, "#text", false);
  const album = parseTextField(value.album, "#text", true);
  const date = value.date;
  if (!isObject(date)) throw new LastfmClientError(LastfmClientErrorCategory.InvalidResponse);
  const scrobbledAtSeconds = parseInteger(date.uts, 0, Math.floor(Number.MAX_SAFE_INTEGER / 1_000));

  return {
    albumName: album,
    artistMusicbrainzId: parseOptionalTextField(value.artist, "mbid"),
    artistName: artist,
    loved: parseLoved(value.loved),
    recordingMusicbrainzId: parseOptionalText(value.mbid),
    releaseMusicbrainzId: parseOptionalTextField(value.album, "mbid"),
    scrobbledAtEpochMs: scrobbledAtSeconds * 1_000,
    trackName: parseText(value.name, false),
  };
}

function parseLoved(value: unknown): boolean | null {
  if (value === undefined || value === null || value === "") return null;
  if (value === "0") return false;
  if (value === "1") return true;
  throw new LastfmClientError(LastfmClientErrorCategory.InvalidResponse);
}

function parseTextField(value: unknown, key: string, nullable: false): string;
function parseTextField(value: unknown, key: string, nullable: true): string | null;
function parseTextField(value: unknown, key: string, nullable: boolean): string | null;
function parseTextField(value: unknown, key: string, nullable: boolean): string | null {
  if (!isObject(value)) throw new LastfmClientError(LastfmClientErrorCategory.InvalidResponse);
  return parseText(value[key], nullable);
}

function parseOptionalTextField(value: unknown, key: string): string | null {
  if (!isObject(value)) throw new LastfmClientError(LastfmClientErrorCategory.InvalidResponse);
  return parseOptionalText(value[key]);
}

function parseOptionalText(value: unknown): string | null {
  return value === undefined || value === null || value === "" ? null : parseText(value, false);
}

function parseText(value: unknown, nullable: false): string;
function parseText(value: unknown, nullable: true): string | null;
function parseText(value: unknown, nullable: boolean): string | null;
function parseText(value: unknown, nullable: boolean): string | null {
  if (value === undefined || value === null || value === "") {
    if (nullable) return null;
    throw new LastfmClientError(LastfmClientErrorCategory.InvalidResponse);
  }
  if (!isNonBlankSafeText(value))
    throw new LastfmClientError(LastfmClientErrorCategory.InvalidResponse);
  return value;
}

function parseInteger(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new LastfmClientError(LastfmClientErrorCategory.InvalidResponse);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new LastfmClientError(LastfmClientErrorCategory.InvalidResponse);
  }
  return parsed;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankSafeText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && !/\p{Cc}/u.test(value);
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function lastfmClientErrorSummary(category: LastfmClientErrorCategory): string {
  return {
    [LastfmClientErrorCategory.Api]: "Last.fm returned an API error",
    [LastfmClientErrorCategory.Http]: "Last.fm returned an unsuccessful HTTP response",
    [LastfmClientErrorCategory.InvalidRequest]: "Last.fm request parameters are invalid",
    [LastfmClientErrorCategory.InvalidResponse]: "Last.fm returned an invalid response",
    [LastfmClientErrorCategory.Timeout]: "Last.fm request timed out",
    [LastfmClientErrorCategory.Transport]: "Last.fm transport request failed",
  }[category];
}
