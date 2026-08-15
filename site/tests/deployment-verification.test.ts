import { describe, expect, it } from "vitest";

import {
  CANONICAL_SITE_ORIGIN,
  type DeploymentFetcher,
  type DeploymentResponse,
  verifyDeployedSite,
} from "../scripts/verify-deployed-site.ts";

const expected = {
  manifestSha256: "1".repeat(64),
  schemaVersion: "active-public-snapshot-v1",
  snapshotId: "snapshot-2026-08-15-deployment",
  snapshotSha256: "2".repeat(64),
} as const;

function response(
  url: string,
  body: string,
  options: { readonly cacheControl?: string; readonly contentType?: string } = {},
): DeploymentResponse {
  const headers = new Map<string, string>([
    ["content-type", options.contentType ?? "text/html; charset=utf-8"],
    ...(options.cacheControl === undefined
      ? []
      : ([["cache-control", options.cacheControl]] as const)),
  ]);
  return {
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    ok: true,
    status: 200,
    url,
    text: async () => body,
  };
}

function deploymentHtml(snapshotId: string = expected.snapshotId): string {
  return `<!doctype html><html><head>
    <link rel="canonical" href="${CANONICAL_SITE_ORIGIN}/">
    <link rel="stylesheet" href="/_astro/index.abcdefgh.css">
    <meta name="musicology:snapshot-id" content="${snapshotId}">
    <meta name="musicology:snapshot-sha256" content="${expected.snapshotSha256}">
  </head><body>Musicology</body></html>`;
}

function fetcherFor(html: string, cacheControl = "public, max-age=600"): DeploymentFetcher {
  return async (input) => {
    if (input.startsWith("http://")) {
      return response(`${CANONICAL_SITE_ORIGIN}/`, "");
    }
    if (input.endsWith(".css")) {
      return response(input, "body{}", { cacheControl, contentType: "text/css" });
    }
    return response(input, html);
  };
}

describe("deployed GitHub Pages verification", () => {
  it("binds canonical HTTPS HTML and a cache-addressed asset to the active approved snapshot", async () => {
    await expect(
      verifyDeployedSite({ expected, fetcher: fetcherFor(deploymentHtml()) }),
    ).resolves.toEqual({
      assetPath: "/_astro/index.abcdefgh.css",
      canonicalUrl: `${CANONICAL_SITE_ORIGIN}/`,
      snapshotId: expected.snapshotId,
      snapshotSha256: expected.snapshotSha256,
    });
  });

  it("rejects a deployed artifact from another approved snapshot", async () => {
    await expect(
      verifyDeployedSite({
        expected,
        fetcher: fetcherFor(deploymentHtml("snapshot-2026-08-15-other")),
      }),
    ).rejects.toMatchObject({ code: "deployment_mismatch" });
  });

  it("rejects mixed content and non-cacheable hashed assets", async () => {
    await expect(
      verifyDeployedSite({
        expected,
        fetcher: fetcherFor(`${deploymentHtml()}<script src="http://example.test/x.js"></script>`),
      }),
    ).rejects.toMatchObject({ code: "deployment_mismatch" });
    await expect(
      verifyDeployedSite({
        expected,
        fetcher: fetcherFor(deploymentHtml(), "private, no-store"),
      }),
    ).rejects.toMatchObject({ code: "deployment_mismatch" });
  });

  it("retries bounded transient failures without weakening the final snapshot check", async () => {
    let attempts = 0;
    const fetcher: DeploymentFetcher = async (input) => {
      if (input.startsWith("http://")) {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
        return response(`${CANONICAL_SITE_ORIGIN}/`, "");
      }
      return fetcherFor(deploymentHtml())(input);
    };
    await expect(verifyDeployedSite({ attempts: 2, expected, fetcher })).resolves.toMatchObject({
      snapshotId: expected.snapshotId,
    });
    expect(attempts).toBe(2);
  });
});
