import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LastfmClient,
  LastfmClientError,
  LastfmClientErrorCategory,
  LASTFM_USER_AGENT,
  serializeLastfmUtcBoundary,
  type LastfmHttpRequest,
  type LastfmHttpResponse,
  type LastfmHttpTransport,
} from "../../../src/lastfm/client.ts";

const secret = "synthetic-api-secret-not-for-output";
const username = "synthetic-listener";

function completedTrack(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    album: { "#text": "Synthetic Album", mbid: "release-id" },
    artist: { "#text": "Synthetic Artist", mbid: "artist-id" },
    date: { uts: "1767225600" },
    loved: "0",
    mbid: "recording-id",
    name: "Synthetic Track",
    ...overrides,
  };
}

function pagePayload(
  track: readonly unknown[],
  pagination: Readonly<Record<string, string>> = {},
): Record<string, unknown> {
  return {
    recenttracks: {
      "@attr": {
        page: "1",
        perPage: "200",
        total: String(track.length),
        totalPages: track.length === 0 ? "0" : "1",
        ...pagination,
      },
      track,
    },
  };
}

function response(status: number, payload: unknown): LastfmHttpResponse {
  return { status, text: async () => JSON.stringify(payload) };
}

function transportReturning(value: LastfmHttpResponse): {
  readonly requests: LastfmHttpRequest[];
  readonly transport: LastfmHttpTransport;
} {
  const requests: LastfmHttpRequest[] = [];
  return {
    requests,
    transport: {
      request: async (request) => {
        requests.push(request);
        return value;
      },
    },
  };
}

function client(transport: LastfmHttpTransport): LastfmClient {
  return new LastfmClient({ apiKey: secret, username }, { transport });
}

async function expectClientError(
  operation: () => Promise<unknown>,
  category: LastfmClientErrorCategory,
): Promise<LastfmClientError> {
  try {
    await operation();
    assert.fail("Expected LastfmClientError");
  } catch (error) {
    assert.ok(error instanceof LastfmClientError);
    assert.equal(error.category, category);
    return error;
  }
}

describe("Last.fm API client", () => {
  it("validates and projects a completed page with pagination metadata", async () => {
    const stub = transportReturning(response(200, pagePayload([completedTrack()])));

    const result = await client(stub.transport).getRecentTracksPage({
      fromEpochMs: Date.parse("2026-01-01T00:00:00.000Z"),
      toEpochMs: Date.parse("2026-01-02T00:00:00.000Z"),
    });

    assert.deepEqual(result, {
      completedTracks: [
        {
          albumName: "Synthetic Album",
          artistMusicbrainzId: "artist-id",
          artistName: "Synthetic Artist",
          loved: false,
          recordingMusicbrainzId: "recording-id",
          releaseMusicbrainzId: "release-id",
          scrobbledAtEpochMs: 1_767_225_600_000,
          trackName: "Synthetic Track",
        },
      ],
      ignoredNowPlayingCount: 0,
      pagination: { page: 1, perPage: 200, total: 1, totalPages: 1 },
    });
    const requestedUrl = new URL(stub.requests[0]?.url ?? "");
    assert.equal(requestedUrl.searchParams.get("from"), "1767225600");
    assert.equal(requestedUrl.searchParams.get("to"), "1767312000");
    assert.equal(requestedUrl.searchParams.get("format"), "json");
    assert.equal(stub.requests[0]?.headers["User-Agent"], LASTFM_USER_AGENT);
  });

  it("ignores currently playing items without accepting their missing completion time", async () => {
    const stub = transportReturning(
      response(
        200,
        pagePayload([
          { "@attr": { nowplaying: "true" }, artist: { "#text": "Live" }, name: "Now" },
          completedTrack(),
        ]),
      ),
    );

    const result = await client(stub.transport).getRecentTracksPage({ fromEpochMs: 0 });

    assert.equal(result.ignoredNowPlayingCount, 1);
    assert.equal(result.completedTracks.length, 1);
  });

  it("rejects malformed HTTP JSON and completed-track payloads", async () => {
    const malformedJson: LastfmHttpTransport = {
      request: async () => ({ status: 200, text: async () => "not json" }),
    };
    const malformedTrack = transportReturning(
      response(200, pagePayload([{ name: "Missing artist" }])),
    );

    await expectClientError(
      () => client(malformedJson).getRecentTracksPage({ fromEpochMs: 0 }),
      LastfmClientErrorCategory.InvalidResponse,
    );
    await expectClientError(
      () => client(malformedTrack.transport).getRecentTracksPage({ fromEpochMs: 0 }),
      LastfmClientErrorCategory.InvalidResponse,
    );
  });

  it("rejects pagination metadata that cannot describe the reported result set", async () => {
    for (const pagination of [
      { totalPages: "0" },
      { page: "2" },
      { perPage: "2", total: "3", totalPages: "1" },
      { page: "2", total: "0", totalPages: "0" },
    ]) {
      const stub = transportReturning(response(200, pagePayload([completedTrack()], pagination)));
      await expectClientError(
        () => client(stub.transport).getRecentTracksPage({ fromEpochMs: 0 }),
        LastfmClientErrorCategory.InvalidResponse,
      );
    }
  });

  it("accepts the documented empty-window pagination shape", async () => {
    const stub = transportReturning(response(200, pagePayload([])));

    const result = await client(stub.transport).getRecentTracksPage({ fromEpochMs: 0 });

    assert.deepEqual(result, {
      completedTracks: [],
      ignoredNowPlayingCount: 0,
      pagination: { page: 1, perPage: 200, total: 0, totalPages: 0 },
    });
  });

  it("classifies HTTP and Last.fm API errors without exposing remote messages", async () => {
    const http = transportReturning(response(503, { message: secret }));
    const api = transportReturning(response(200, { error: "29", message: secret }));

    const httpError = await expectClientError(
      () => client(http.transport).getRecentTracksPage({ fromEpochMs: 0 }),
      LastfmClientErrorCategory.Http,
    );
    const apiError = await expectClientError(
      () => client(api.transport).getRecentTracksPage({ fromEpochMs: 0 }),
      LastfmClientErrorCategory.Api,
    );

    assert.equal(httpError.httpStatus, 503);
    assert.equal(apiError.apiCode, 29);
    assert.equal(httpError.message.includes(secret), false);
    assert.equal(apiError.message.includes(secret), false);
  });

  it("redacts request details from transport failures while retaining no secret-bearing error data", async () => {
    const transport: LastfmHttpTransport = {
      request: async () => {
        throw new Error(`request failed at https://example.test/?api_key=${secret}`);
      },
    };

    const error = await expectClientError(
      () => client(transport).getRecentTracksPage({ fromEpochMs: 0 }),
      LastfmClientErrorCategory.Transport,
    );

    assert.equal(error.message.includes(secret), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
  });

  it("aborts through the injected clock and classifies the request as a timeout", async () => {
    let clearedTimeout: unknown;
    const timedOutClient = new LastfmClient(
      { apiKey: secret, username },
      {
        clock: {
          now: () => 0,
          setTimeout: (callback) => {
            callback();
            return "timeout-handle";
          },
          clearTimeout: (handle) => {
            clearedTimeout = handle;
          },
        },
        transport: {
          request: async (request) => {
            assert.equal(request.signal.aborted, true);
            throw new Error("aborted");
          },
        },
      },
    );

    await expectClientError(
      () => timedOutClient.getRecentTracksPage({ fromEpochMs: 0 }),
      LastfmClientErrorCategory.Timeout,
    );
    assert.equal(clearedTimeout, "timeout-handle");
  });

  it("keeps the timeout active while reading the response body", async () => {
    let clearedTimeout: unknown;
    let timeoutCallback: (() => void) | undefined;
    let markBodyRead: (() => void) | undefined;
    const bodyRead = new Promise<void>((resolve) => {
      markBodyRead = resolve;
    });
    const timedOutClient = new LastfmClient(
      { apiKey: secret, username },
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
        transport: {
          request: async (request) => ({
            status: 200,
            text: () =>
              new Promise<string>((_resolve, reject) => {
                request.signal.addEventListener("abort", () => reject(new Error("aborted")), {
                  once: true,
                });
                markBodyRead?.();
              }),
          }),
        },
      },
    );

    const operation = timedOutClient.getRecentTracksPage({ fromEpochMs: 0 });
    await bodyRead;
    assert.ok(timeoutCallback !== undefined);
    const expectedTimeout = expectClientError(() => operation, LastfmClientErrorCategory.Timeout);
    timeoutCallback();

    await expectedTimeout;
    assert.equal(clearedTimeout, "timeout-handle");
  });

  it("serializes UTC millisecond instants as inclusive Last.fm Unix-second boundaries", () => {
    assert.equal(serializeLastfmUtcBoundary(Date.parse("2025-12-31T23:59:59.999Z")), "1767225599");
    assert.equal(serializeLastfmUtcBoundary(Date.parse("2026-01-01T00:00:00.000Z")), "1767225600");
  });
});
