import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { loadConfiguration, repositoryRoot } from "../../src/config/config.ts";
import {
  type ActivePublicSnapshotPointer,
  readActivePublicSnapshot,
} from "../../src/publication/workflow.ts";

export const CANONICAL_SITE_ORIGIN = "https://music.the816.com";

interface DeploymentHeaders {
  get(name: string): string | null;
}

export interface DeploymentResponse {
  readonly headers: DeploymentHeaders;
  readonly ok: boolean;
  readonly status: number;
  readonly url: string;
  text(): Promise<string>;
}

export type DeploymentFetcher = (input: string) => Promise<DeploymentResponse>;

export interface VerifyDeployedSiteOptions {
  readonly attempts?: number;
  readonly delayMs?: number;
  readonly expected: ActivePublicSnapshotPointer;
  readonly fetcher?: DeploymentFetcher;
  readonly origin?: string;
}

export interface DeployedSiteSummary {
  readonly assetPath: string;
  readonly canonicalUrl: string;
  readonly snapshotId: string;
  readonly snapshotSha256: string;
}

export class DeployedSiteVerificationError extends Error {
  readonly code: "deployment_mismatch" | "deployment_unreachable" | "invalid_arguments";

  constructor(
    code: DeployedSiteVerificationError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DeployedSiteVerificationError";
    this.code = code;
  }
}

export async function verifyDeployedSite(
  options: VerifyDeployedSiteOptions,
): Promise<DeployedSiteSummary> {
  const origin = validateOrigin(options.origin ?? CANONICAL_SITE_ORIGIN);
  const attempts = positiveInteger(options.attempts ?? 1, "attempts");
  const delayMs = nonnegativeInteger(options.delayMs ?? 0, "delayMs");
  const fetcher = options.fetcher ?? defaultFetcher;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await verifyOnce(fetcher, origin, options.expected);
    } catch (error) {
      lastError = error;
      if (attempt < attempts && delayMs > 0) await delay(delayMs);
    }
  }

  if (lastError instanceof DeployedSiteVerificationError) throw lastError;
  throw new DeployedSiteVerificationError(
    "deployment_unreachable",
    "The deployed site could not be reached over HTTPS",
    { cause: lastError },
  );
}

async function verifyOnce(
  fetcher: DeploymentFetcher,
  origin: URL,
  expected: ActivePublicSnapshotPointer,
): Promise<DeployedSiteSummary> {
  try {
    const insecureUrl = new URL("/", origin);
    insecureUrl.protocol = "http:";
    const redirect = await fetcher(insecureUrl.href);
    const redirectUrl = new URL(redirect.url);
    if (!redirect.ok || redirectUrl.protocol !== "https:" || redirectUrl.origin !== origin.origin) {
      mismatch("HTTP does not redirect to the approved HTTPS site");
    }

    const canonicalUrl = new URL("/", origin).href;
    const response = await fetcher(canonicalUrl);
    if (!response.ok || response.status !== 200 || new URL(response.url).origin !== origin.origin) {
      mismatch("The canonical HTTPS origin did not serve the expected root document");
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("text/html")) {
      mismatch("The deployed root document is not HTML");
    }
    const html = await response.text();
    requireHtmlValue(html, "link", "rel", "canonical", "href", canonicalUrl);
    requireHtmlValue(
      html,
      "meta",
      "name",
      "musicology:snapshot-id",
      "content",
      expected.snapshotId,
    );
    requireHtmlValue(
      html,
      "meta",
      "name",
      "musicology:snapshot-sha256",
      "content",
      expected.snapshotSha256,
    );
    if (/\b(?:href|src)=["']http:\/\//u.test(html)) {
      mismatch("The deployed root document contains mixed-content asset references");
    }

    const assetPath = firstHashedAssetPath(html);
    const asset = await fetcher(new URL(assetPath, origin).href);
    if (!asset.ok || asset.status !== 200) mismatch("A hashed deployment asset is unavailable");
    const cacheControl = (asset.headers.get("cache-control") ?? "").toLowerCase();
    if (cacheControl.includes("no-store") || cacheControl.includes("private")) {
      mismatch("The hashed deployment asset is not publicly cacheable");
    }

    return {
      assetPath,
      canonicalUrl,
      snapshotId: expected.snapshotId,
      snapshotSha256: expected.snapshotSha256,
    };
  } catch (error) {
    if (error instanceof DeployedSiteVerificationError) throw error;
    throw new DeployedSiteVerificationError(
      "deployment_unreachable",
      "The deployed site could not be reached over HTTPS",
      { cause: error },
    );
  }
}

function requireHtmlValue(
  html: string,
  element: "link" | "meta",
  identifyingAttribute: string,
  identifyingValue: string,
  valueAttribute: string,
  expectedValue: string,
): void {
  const tags = html.match(new RegExp(`<${element}\\b[^>]*>`, "gu")) ?? [];
  const tag = tags.find(
    (candidate) => attributeValue(candidate, identifyingAttribute) === identifyingValue,
  );
  if (tag === undefined || attributeValue(tag, valueAttribute) !== expectedValue) {
    mismatch(`The deployed document has an invalid ${identifyingValue} marker`);
  }
}

function attributeValue(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "u"));
  return match?.[1];
}

function firstHashedAssetPath(html: string): string {
  const paths = [...html.matchAll(/(?:href|src)=["']([^"']+)["']/gu)].map((match) => match[1]);
  const asset = paths.find(
    (candidate): candidate is string =>
      candidate !== undefined &&
      /^\/_astro\/[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]{8,}\.(?:css|js)$/u.test(candidate),
  );
  if (asset === undefined) mismatch("The deployed document has no cache-addressed asset");
  return asset;
}

function validateOrigin(value: string): URL {
  try {
    const origin = new URL(value);
    if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) {
      throw new Error("invalid origin");
    }
    return origin;
  } catch {
    throw new DeployedSiteVerificationError(
      "invalid_arguments",
      "Deployment origin must be an HTTPS origin without a path, query, or fragment",
    );
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DeployedSiteVerificationError("invalid_arguments", `${label} must be positive`);
  }
  return value;
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DeployedSiteVerificationError("invalid_arguments", `${label} must not be negative`);
  }
  return value;
}

function mismatch(message: string): never {
  throw new DeployedSiteVerificationError("deployment_mismatch", message);
}

async function defaultFetcher(input: string): Promise<DeploymentResponse> {
  return fetch(input, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  let json = false;
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: false,
      options: {
        attempts: { type: "string", default: "1" },
        "delay-ms": { type: "string", default: "0" },
        json: { type: "boolean", default: false },
        origin: { type: "string", default: CANONICAL_SITE_ORIGIN },
      },
      strict: true,
    });
    json = parsed.values.json;
    const expected = readActivePublicSnapshot(
      loadConfiguration({ repositoryRoot }).paths.publicationDirectory,
    );
    const summary = await verifyDeployedSite({
      attempts: Number(parsed.values.attempts),
      delayMs: Number(parsed.values["delay-ms"]),
      expected,
      origin: parsed.values.origin,
    });
    process.stdout.write(
      json
        ? `${JSON.stringify({ command: "site:verify:deployed", data: summary, status: "success" })}\n`
        : `Verified deployed snapshot ${summary.snapshotId} at ${summary.canonicalUrl}.\n`,
    );
  } catch (error) {
    const safe =
      error instanceof DeployedSiteVerificationError
        ? error
        : new DeployedSiteVerificationError(
            "deployment_unreachable",
            "The deployed site could not be verified",
          );
    process.stderr.write(
      json
        ? `${JSON.stringify({
            command: "site:verify:deployed",
            errors: [{ code: safe.code, message: safe.message }],
            status: "error",
          })}\n`
        : `Deployment verification failed [${safe.code}]: ${safe.message}\n`,
    );
    process.exitCode = 4;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) await main();
