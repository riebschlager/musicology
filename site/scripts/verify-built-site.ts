import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const root = path.join(process.cwd(), "site", "dist");
const baseRoutes: readonly (readonly [string, boolean, boolean | "optional"])[] = [
  ["404.html", false, false],
  ["index.html", true, true],
  ["artists/index.html", true, "optional"],
  ["explore/index.html", true, true],
  ["history/index.html", true, true],
  ["methodology/index.html", true, false],
  ["stories/index.html", true, "optional"],
] as const;
const artistDirectory = path.join(root, "artists");
const artistDetailRoutes = readdirSync(artistDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => [`artists/${entry.name}/index.html`, true, true] as const)
  .toSorted(([left], [right]) => left.localeCompare(right));
const storyDirectory = path.join(root, "stories");
const storyDetailRoutes = readdirSync(storyDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => [`stories/${entry.name}/index.html`, true, false] as const)
  .toSorted(([left], [right]) => left.localeCompare(right));
const routes = [...baseRoutes, ...artistDetailRoutes, ...storyDetailRoutes];

const privateFieldTokens = [
  "canonicalSnapshotSha256",
  "databaseState",
  "entityId",
  "inputFiles",
  "ipAddress",
  "selectionKey",
  "sourcePath",
  "spotifyCountry",
  "spotifyPlatform",
] as const;

const cssFiles = listFiles(root).filter((file) => file.endsWith(".css"));
assert.ok(cssFiles.length > 0, "A hashed static stylesheet is required");
const css = cssFiles.map((file) => readFileSync(file, "utf8")).join("\n");
const clientJavaScript = listFiles(root)
  .filter((file) => file.endsWith(".js"))
  .map((file) => readFileSync(file))
  .reduce((total, bytes) => total + gzipSync(bytes).length, 0);
const hashedAssets = listFiles(path.join(root, "_astro")).filter((file) =>
  /[\\/][a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]{8,}\.(?:css|js)$/u.test(file),
);
assert.ok(hashedAssets.length > 0, "Cache-addressed static assets are required");
assert.equal(
  readFileSync(path.join(root, "CNAME"), "utf8"),
  "music.the816.com\n",
  "The built custom-domain marker must remain canonical",
);
assert.match(css, /prefers-reduced-motion:reduce/u);
assert.match(css, /forced-colors:active/u);
assert.match(css, /width<=44rem/u);

for (const [relativeFile, analytical, interactive] of routes) {
  const file = path.join(root, relativeFile);
  const html = readFileSync(file, "utf8");
  assert.ok(statSync(file).size <= 150 * 1024, `${relativeFile} exceeds the HTML budget`);
  assert.match(html, /^<!DOCTYPE html>/u);
  assert.match(html, /<html lang="en">/u);
  assert.match(html, /<title>[^<]+<\/title>/u);
  assert.match(html, /<link rel="canonical" href="https:\/\/music\.the816\.com\//u);
  assert.match(html, /<meta property="og:title"/u);
  assert.match(
    html,
    /<meta name="musicology:snapshot-id" content="snapshot-\d{4}-\d{2}-\d{2}-[a-z0-9-]+">/u,
  );
  assert.match(html, /<meta name="musicology:snapshot-sha256" content="[a-f0-9]{64}">/u);
  assert.match(html, /<a class="skip-link" href="#main-content">/u);
  assert.match(html, /<nav class="site-nav" aria-label="Primary">/u);
  assert.match(html, /<main id="main-content" tabindex="-1">/u);
  assert.match(html, /<h1>[^<]+<\/h1>/u);
  assert.match(html, /<footer class="site-footer">/u);
  const hasScript = /<script\b/u.test(html);
  if (interactive === true) {
    assert.match(html, /<script\b/u);
    assert.ok(clientJavaScript <= 125 * 1024, "Interactive route JavaScript exceeds its budget");
  } else if (interactive === false) {
    assert.doesNotMatch(html, /<script\b/u);
  }
  assert.doesNotMatch(html, /(?:href|src)="https:\/\/(?!music\.the816\.com)/u);
  if (analytical) {
    assert.match(html, />The analytical envelope</u);
    assert.match(html, />Spotify-only duration</u);
    assert.match(html, />Source gaps</u);
    assert.match(html, />Unresolved proportion</u);
    assert.match(html, />Genre coverage &(?:amp;)? freshness</u);
    assert.match(html, />Time &(?:amp;)? release</u);
  }
  for (const token of privateFieldTokens) {
    assert.doesNotMatch(html, new RegExp(token, "u"));
  }
  assert.ok(
    gzipSync(html).length + gzipSync(css).length + (hasScript ? clientJavaScript : 0) <= 250 * 1024,
    `${relativeFile} exceeds the conservative shell transfer budget`,
  );
}

const historyHtml = readFileSync(path.join(root, "history", "index.html"), "utf8");
const emptyHistory = /No reviewed history rows/u.test(historyHtml);
if (emptyHistory) {
  assert.doesNotMatch(
    historyHtml,
    /long-view-table/u,
    "Empty history must not fabricate a chart or table",
  );
  assert.match(historyHtml, /No zero timeline is invented/u);
} else {
  assert.match(
    historyHtml,
    /href="#long-view-table"/u,
    "The History chart must link to its equivalent data table",
  );
  assert.match(
    historyHtml,
    /id="long-view-table"/u,
    "The History chart's equivalent data table must exist",
  );
}

const allFiles = listFiles(root);
assert.equal(
  allFiles.some((file) => file.endsWith(".map")),
  false,
  "Source maps must not ship",
);
assert.equal(
  allFiles.some((file) => file.endsWith(".json")),
  false,
  "Snapshot JSON must not ship",
);

console.log(
  `Verified ${routes.length} static route files (${artistDetailRoutes.length} eligible artist detail, ${storyDetailRoutes.length} reviewed story detail) and ${allFiles.length} total assets.`,
);

function listFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true })
    .map((entry) => path.join(directory, String(entry)))
    .filter((entry) => statSync(entry).isFile())
    .toSorted();
}
