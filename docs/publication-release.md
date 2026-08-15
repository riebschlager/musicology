# Publication release and GitHub Pages deployment

P6-10 separates private candidate generation, human review, immutable approval, active-snapshot
selection, static build, and GitHub Pages deployment. None of the commands below commits, pushes,
or changes GitHub settings. Run them from the repository root with the pinned Node.js 24 and pnpm 9
toolchain.

## Responsibilities and cadence

The archive owner decides when a refresh is warranted, prepares the reviewed
`publication-input-v1` editorial/selection document, inspects every proposed public byte, and makes
the approval decision. A maintainer reviews the resulting committed approved snapshot and release
workflow changes. The protected `github-pages` environment controls the final deployment.

There is no automatic refresh cadence. Import, sync, reconciliation, enrichment, analysis, and
ordinary pushes never generate or approve public data. A normal push to `main` only rebuilds and
redeploys the already committed active approved snapshot.

## Generate a private candidate

First update and verify the private analytical export against the current migrated database:

```sh
pnpm export:analytics
pnpm export:analytics --check
```

Prepare a separately reviewed publication input matching `publication-input-v1`. The synthetic
builders in `tests/fixtures/publication.ts` demonstrate the closed shape without containing private
archive records. Snapshot IDs use `snapshot-YYYY-MM-DD-description`; the date and input content are
explicit so candidate bytes remain reproducible.

```sh
pnpm publication:generate \
  --input path/to/reviewed-publication-input.json \
  --generated-on YYYY-MM-DD
```

Use `--json` for the stable command envelope. Generation verifies migrations, proves the existing
`analytics-v2` bundle is current and byte-compatible with the database, projects only allowlisted
fields, compares with the active approved snapshot when one exists, and atomically writes the
candidate under ignored `data/outputs/publication-candidates/<snapshot-id>/`. It does not approve,
activate, commit, build, or deploy anything.

## Validate and review

```sh
pnpm publication:review --snapshot snapshot-YYYY-MM-DD-description
pnpm publication:review --snapshot snapshot-YYYY-MM-DD-description --json
```

The command revalidates all hashes, schemas, cross-artifact references, report bindings, and public
field allowlists. Review the exact `review-report.json`, `manifest.json`, `history.json`,
`artists.json`, `editorial.json`, and `stories.json` bytes in the candidate directory. Confirm:

- the proposed fields, aggregate counts, date range, timezone, as-of date, analytical versions,
  coverage, and selection-policy version;
- every added, removed, or changed public slug and every selected artist/track display identity;
- authored claims, supersession links, source-gap qualifications, and empty states;
- that `genre-lab.json` is absent and `artifacts.genreLab` remains `null`;
- that no private ID, exact event timestamp, source path, fingerprint, private analytical passthrough,
  remote asset, external request, visitor analytics, or unlicensed material is present; and
- the exact `reportSha256` printed by the command. Approval requires this digest as an explicit
  review confirmation.

## Approve and activate

Approval copies the already reviewed bytes into a new immutable approved directory. It neither
regenerates the candidate nor changes the active pointer:

```sh
pnpm publication:approve \
  --snapshot snapshot-YYYY-MM-DD-description \
  --decided-on YYYY-MM-DD \
  --report-sha256 <reviewed-report-sha256>
```

A changed candidate or mismatched report digest fails closed. After approval, select it explicitly:

```sh
pnpm publication:activate --snapshot snapshot-YYYY-MM-DD-description
```

Only these files are intentionally committable:

```text
data/publication/approved/<snapshot-id>/
data/publication/active.json
```

`MUSICOLOGY_PUBLICATION_DIR` may isolate these files for tests or local release rehearsal. A real
release must use the repository-local default shown above so the approved bytes and active pointer
can be reviewed and committed. Publication commands, production builds, and live verification use
the same configured directory.

Before committing, inspect Git status and confirm that no file under `data/inputs`, `data/database`,
`data/outputs`, no SQLite sidecar, and no unrelated generated file is staged. Candidates and private
analytical bundles remain ignored even after approval.

## Production build and local preview

The production command has no fixture fallback. It reads only the committed-style active pointer
and approved snapshot, builds the static Astro site, validates privacy/metadata/budgets, checks the
custom-domain marker and cache-addressed assets, and fails if any approved byte or hash is missing:

```sh
pnpm publication:build
pnpm site:serve
```

Open `http://127.0.0.1:4321/` for the local static preview. Fixture development remains separate:
`pnpm site:build:fixture` and pull-request checks can inspect synthetic data but can never satisfy
the production build or deploy boundary.

## GitHub Pages and custom-domain setup

Repository administrators perform the one-time external setup:

1. In **Settings → Pages**, choose **GitHub Actions** as the publishing source.
2. Create or retain the `github-pages` environment. Restrict its deployment branches to `main` and
   require the desired reviewer approval before deployment.
3. In Pages settings, set the custom domain to `music.the816.com`. With an Actions publishing source,
   the repository setting is authoritative; `site/public/CNAME` is a deterministic built-artifact
   marker and is not a substitute for that setting.
4. At the DNS provider, create a `CNAME` for `music.the816.com` pointing directly to
   `riebschlager.github.io`—not to the apex domain and not to a URL containing this repository name.
   Avoid wildcard DNS records. DNS and certificate provisioning can take up to 24 hours.
5. After GitHub reports a successful DNS check and certificate, enable **Enforce HTTPS**.

The site configuration fixes `https://music.the816.com` as the origin with no base path. Canonical
URLs and assets therefore remain rooted at `/`; Astro emits content-addressed CSS/JavaScript names,
and the built/live verification gates reject mixed content or non-cacheable deployment assets.

## Protected deployment behavior

`.github/workflows/pages.yml` runs only for a push to `main` or an explicit workflow dispatch. Its
build job has read-only repository permission, installs the frozen lockfile under the pinned
toolchain, runs `pnpm quality`, builds from `data/publication/active.json`, verifies the static
artifact, and uploads only `site/dist`.

Only the dependent deploy job receives `pages: write` and `id-token: write`, and that job is bound to
the protected `github-pages` environment. It deploys the uploaded artifact and then verifies that
the canonical HTTPS host serves the expected snapshot ID/hash, canonical URL, HTTPS redirect, and a
cacheable hashed asset. Pull requests use the fixture-only CI workflow and have no Pages permission.
No GitHub Actions job invokes candidate generation, approval, activation, a private database, or a
private analytical export.

After a deployment, the same live check can be repeated locally without reading private data:

```sh
pnpm site:verify:deployed
```

## Rollback

All approved directories are immutable and retained. To restore an earlier reviewed release, use
only its committed snapshot ID:

```sh
pnpm publication:activate --snapshot snapshot-YYYY-MM-DD-prior
pnpm publication:build
```

Review the active-pointer diff, commit that pointer change, and push it through the normal protected
`main` workflow. The rebuild and deployment require no private input, SQLite database, analytical
bundle, candidate regeneration, or provider request. If the current code itself is unsuitable,
restore or redeploy a prior reviewed commit whose pointer names that same retained approved
snapshot. A privacy or secret incident is not an ordinary rollback: disable Pages/deployment,
remove DNS if necessary, and follow repository-history incident remediation.

## Troubleshooting and publication cautions

- **No active approved snapshot:** `pnpm publication:build` and the Pages workflow fail closed. Run
  review, approval, and activation locally; do not point production at a fixture.
- **Stale or incompatible analytics:** regenerate `analytics-v2`, rerun `export:analytics --check`,
  and investigate schema/version drift. Do not weaken the private-bundle validator.
- **Candidate/report hash mismatch:** discard the approval attempt, validate the candidate again,
  inspect why bytes changed, and approve only the newly reviewed digest.
- **Pages build succeeds but deployment is blocked:** check `github-pages` environment protection,
  Pages source, action permissions, and the active approved files. Do not grant Pages write access to
  fixture or pull-request jobs.
- **Custom domain or HTTPS fails:** confirm the Pages custom-domain setting, the direct DNS CNAME,
  DNS propagation, certificate status, and **Enforce HTTPS**. Do not point the subdomain at the apex.
- **Live verification reports the wrong snapshot:** treat it as a failed release. Do not approve new
  data to fix deployment drift; restore/deploy the intended committed artifact.

Public approval is a disclosure decision, not a routine build step. Never use private archive rows
as fixtures, paste rejected payloads into diagnostics, or infer that successful schema validation
alone makes authored content, selected names, links, assets, or claims appropriate to publish.
