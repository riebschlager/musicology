import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GenreEnrichmentSnapshot } from "../../../src/genre/evidence-contract.ts";
import {
  type CachedGenreEnrichmentSnapshot,
  type GenreEnrichmentSnapshotCache,
  MusicbrainzClientError,
  MusicbrainzClientErrorCategory,
  MusicbrainzGenreClient,
  type MusicbrainzHttpRequest,
  type MusicbrainzHttpResponse,
  type MusicbrainzHttpTransport,
  musicbrainzArtistUrl,
} from "../../../src/genre/musicbrainz-client.ts";

const target = { artistId: 7, musicbrainzArtistId: "c0ffee00-cafe-4000-8000-000000000001" };
const secret = "synthetic-provider-secret-not-for-output";

class MemoryCache implements GenreEnrichmentSnapshotCache {
  readonly records: CachedGenreEnrichmentSnapshot[] = [];

  async latest(): Promise<CachedGenreEnrichmentSnapshot | undefined> {
    return this.records.at(-1);
  }

  async record(snapshot: GenreEnrichmentSnapshot): Promise<CachedGenreEnrichmentSnapshot> {
    const stored = { snapshot, snapshotId: this.records.length + 1 };
    this.records.push(stored);
    return stored;
  }
}

function response(
  status: number,
  payload: unknown,
  headers?: Readonly<Record<string, string>>,
): MusicbrainzHttpResponse {
  return {
    ...(headers === undefined ? {} : { headers }),
    status,
    text: async () => JSON.stringify(payload),
  };
}

function transportReturning(...responses: MusicbrainzHttpResponse[]): {
  readonly requests: MusicbrainzHttpRequest[];
  readonly transport: MusicbrainzHttpTransport;
} {
  const requests: MusicbrainzHttpRequest[] = [];
  let index = 0;
  return {
    requests,
    transport: {
      request: async (request) => {
        requests.push(request);
        return responses[index++] ?? response(500, { message: secret });
      },
    },
  };
}

function client(
  transport: MusicbrainzHttpTransport,
  overrides: ConstructorParameters<typeof MusicbrainzGenreClient>[0] = {},
): MusicbrainzGenreClient {
  return new MusicbrainzGenreClient({
    maxRetries: 0,
    rateLimitIntervalMs: 1,
    sleep: async () => undefined,
    transport,
    ...overrides,
  });
}

async function collect(client: MusicbrainzGenreClient, cache: MemoryCache, options = {}) {
  const result = [];
  for await (const item of client.enrichArtists([target], cache, options)) result.push(item);
  return result;
}

describe("MusicBrainz genre enrichment client", () => {
  it("allowlist-projects successful raw tags and recognized genres", async () => {
    const stub = transportReturning(
      response(200, {
        id: target.musicbrainzArtistId,
        tags: [{ name: "Dream Pop", count: 12 }],
        genres: [{ name: "rock", count: 4 }],
        private_message: secret,
      }),
    );
    const cache = new MemoryCache();
    const [result] = await collect(client(stub.transport), cache);

    assert.equal(result?.action, "fetched");
    assert.deepEqual(result?.snapshot?.rawTags, [
      {
        rawTagName: "Dream Pop",
        normalizedRawTag: "dream pop",
        rawWeight: 12,
        confidence: null,
        isRecognizedGenre: false,
      },
      {
        rawTagName: "rock",
        normalizedRawTag: "rock",
        rawWeight: 4,
        confidence: null,
        isRecognizedGenre: true,
      },
    ]);
    assert.equal(cache.records.length, 1);
    assert.equal(stub.requests[0]?.url, musicbrainzArtistUrl(target.musicbrainzArtistId));
    assert.equal(stub.requests[0]?.headers["User-Agent"]?.includes(secret), false);
  });

  it("uses the recognized-genre record for an overlapping normalized provider tag", async () => {
    const stub = transportReturning(
      response(200, {
        id: target.musicbrainzArtistId,
        tags: [{ name: "Rock", count: 9 }],
        genres: [{ name: "rock", count: 10 }],
      }),
    );

    const [result] = await collect(client(stub.transport), new MemoryCache());

    assert.deepEqual(result?.snapshot?.rawTags, [
      {
        rawTagName: "rock",
        normalizedRawTag: "rock",
        rawWeight: 10,
        confidence: null,
        isRecognizedGenre: true,
      },
    ]);
    assert.equal(result?.snapshot?.outcome, "success");
  });

  it("caches missing entities and never guesses an ambiguous identity", async () => {
    const stub = transportReturning(response(404, { message: secret }));
    const cache = new MemoryCache();
    const [missing] = await collect(client(stub.transport), cache);
    assert.equal(missing?.snapshot?.outcome, "not_found");
    assert.equal(cache.records.length, 1);

    const results = [];
    for await (const result of client(stub.transport).enrichArtists([{ artistId: 8 }], cache))
      results.push(result);
    assert.deepEqual(results, [{ action: "skipped", artistId: 8, reason: "ambiguous_identity" }]);
    assert.equal(stub.requests.length, 1);
  });

  it("records malformed payloads as safe failures without retaining their bodies", async () => {
    const stub = transportReturning(
      response(200, {
        id: target.musicbrainzArtistId,
        tags: [{ name: "ok", count: -1 }],
        message: secret,
      }),
    );
    const [result] = await collect(client(stub.transport), new MemoryCache());
    assert.deepEqual(
      {
        cacheState: result?.snapshot?.cacheState,
        outcome: result?.snapshot?.outcome,
        errorCode: result?.snapshot?.errorCode,
      },
      { cacheState: "failure", outcome: "malformed_response", errorCode: "malformed_response" },
    );
    assert.equal(result?.snapshot ? JSON.stringify(result.snapshot).includes(secret) : true, false);
  });

  it("keeps the timeout active while reading a response body", async () => {
    let clearedTimeout: unknown;
    let timeoutCallback: (() => void) | undefined;
    let markBodyRead: (() => void) | undefined;
    const bodyRead = new Promise<void>((resolve) => {
      markBodyRead = resolve;
    });
    const timedOutClient = client(
      {
        request: async (request) => ({
          status: 200,
          text: () =>
            new Promise<string>((_resolve, reject) => {
              request.signal.addEventListener(
                "abort",
                () => reject(new Error(`body read aborted: ${secret}`)),
                { once: true },
              );
              markBodyRead?.();
            }),
        }),
      },
      {
        clock: {
          now: () => 0,
          setTimeout: (callback) => {
            timeoutCallback = callback;
            return "timeout-handle";
          },
          clearTimeout: (handle) => {
            clearedTimeout = handle;
          },
        },
        maxRetries: 0,
      },
    );

    const operation = timedOutClient.fetchArtist(target);
    await bodyRead;
    assert.ok(timeoutCallback !== undefined);
    timeoutCallback();

    const snapshot = await operation;
    assert.equal(snapshot.cacheState, "failure");
    assert.equal(snapshot.outcome, "temporary_failure");
    assert.equal(snapshot.errorCode, "timeout");
    assert.equal(JSON.stringify(snapshot).includes(secret), false);
    assert.equal(clearedTimeout, "timeout-handle");
  });

  it("honors rate limits, retries transient responses, and returns a safe retry-exhausted failure", async () => {
    const delays: number[] = [];
    const limited = transportReturning(
      response(429, { message: secret }, { "Retry-After": "2" }),
      response(200, { id: target.musicbrainzArtistId, tags: [{ name: "ambient", count: 1 }] }),
    );
    const [retried] = await collect(
      client(limited.transport, {
        maxRetries: 1,
        sleep: async (delay) => {
          delays.push(delay);
        },
      }),
      new MemoryCache(),
    );
    assert.equal(retried?.snapshot?.outcome, "success");
    assert.equal(delays[0], 2_000);

    const exhausted = transportReturning(
      response(503, { message: secret }),
      response(503, { message: secret }),
    );
    const [failed] = await collect(
      client(exhausted.transport, { maxRetries: 1 }),
      new MemoryCache(),
    );
    assert.equal(failed?.snapshot?.outcome, "temporary_failure");
    assert.equal(failed?.snapshot?.errorCode, "retry_exhausted");
  });

  it("does not retry permanent HTTP failures or retain their response bodies", async () => {
    const permanentFailure = transportReturning(response(400, { message: secret }));

    await assert.rejects(
      () => client(permanentFailure.transport, { maxRetries: 3 }).fetchArtist(target),
      (error: unknown) => {
        assert.ok(error instanceof MusicbrainzClientError);
        assert.equal(error.category, MusicbrainzClientErrorCategory.Http);
        assert.equal(error.httpStatus, 400);
        assert.equal(error.message.includes(secret), false);
        assert.equal(JSON.stringify(error).includes(secret), false);
        return true;
      },
    );
    assert.equal(permanentFailure.requests.length, 1);
  });

  it("uses success and negative cache entries, refreshes stale entries, and resumes after interruption", async () => {
    const stub = transportReturning(
      response(200, { id: target.musicbrainzArtistId, tags: [{ name: "ambient", count: 1 }] }),
    );
    const cache = new MemoryCache();
    const cached: GenreEnrichmentSnapshot = {
      artistId: target.artistId,
      provider: "musicbrainz",
      providerEntityId: target.musicbrainzArtistId,
      providerResponseSchemaVersion: "musicbrainz-artist-v1",
      contractVersion: "genre-evidence-v1",
      providerLicense: "CC0 / CC BY-NC-SA",
      providerAttribution: "MusicBrainz",
      fetchedAtEpochMs: 0,
      cacheState: "negative",
      outcome: "no_tags",
      errorCode: null,
      supersedesSnapshotId: null,
      rawTags: [],
    };
    await cache.record(cached);
    const [hit] = await collect(client(stub.transport), cache);
    assert.equal(hit?.action, "cached");
    assert.equal(stub.requests.length, 0);

    const [refreshed] = await collect(client(stub.transport, { refreshAgeMs: 1 }), cache, {
      refresh: true,
    });
    assert.equal(refreshed?.action, "fetched");
    assert.equal(cache.records.at(-1)?.snapshot.supersedesSnapshotId, 1);

    const resumed = transportReturning(
      response(200, { id: target.musicbrainzArtistId, tags: [{ name: "ambient", count: 1 }] }),
    );
    const interruptedCache = new MemoryCache();
    const resumingClient = client(resumed.transport);
    const first = resumingClient.enrichArtists(
      [target, { artistId: 9, musicbrainzArtistId: "c0ffee00-cafe-4000-8000-000000000002" }],
      interruptedCache,
    );
    await first.next();
    const afterInterruption = [];
    for await (const item of resumingClient.enrichArtists([target], interruptedCache))
      afterInterruption.push(item);
    assert.equal(afterInterruption[0]?.action, "cached");
    assert.equal(resumed.requests.length, 1);
  });

  it("supports bounded dry runs without writing cache state", async () => {
    const stub = transportReturning(
      response(200, { id: target.musicbrainzArtistId, tags: [{ name: "ambient", count: 1 }] }),
    );
    const cache = new MemoryCache();
    const results = [];
    for await (const result of client(stub.transport).enrichArtists(
      [target, { artistId: 8, musicbrainzArtistId: "c0ffee00-cafe-4000-8000-000000000002" }],
      cache,
      { dryRun: true, limit: 1 },
    )) {
      results.push(result);
    }
    assert.equal(results[0]?.action, "fetched");
    assert.deepEqual(results[1], { action: "skipped", artistId: 8, reason: "limit_reached" });
    assert.equal(cache.records.length, 0);
    assert.equal(stub.requests.length, 1);
  });
});
