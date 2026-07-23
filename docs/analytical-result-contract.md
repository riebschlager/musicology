# Analytical result contract

P4-01 defines the common JSON envelope for every analytical result. It is implemented in
`src/analytics/result.ts`; the current stable schema identifier is `analytical-result-v1`.

Each result contains:

- its analysis name and human-readable definition;
- an explicit UTC date range and as-of timestamp;
- the presentation IANA timezone and included source set;
- canonical event count, unresolved rate, and any relevant metadata-availability rates;
- validated parameter values;
- analysis, parameter-schema, SQL-query, identity-rule, and reconciliation-rule versions; and
- the analysis-specific `result` payload.

Analyses must derive the identity and reconciliation version lists from the canonical inputs they
actually query. A parameter validator is a TypeScript boundary owned by that analysis; its stable
`schemaVersion` is recorded in `versions.parameterSchema` alongside the accepted parameters. SQL
views or queries likewise receive a stable version identifier in `versions.query`. Changing either
semantic contract requires a new version rather than silently reinterpreting a previous result.

Use `createAnalyticalResult` to validate and normalize an envelope, and
`serializeAnalyticalResult` for JSON output. Serialization recursively sorts object keys, source
names, and rule-version lists, so equal analytical values yield equal bytes (with one trailing
newline). Object-key order uses locale-independent UTF-16 code-unit comparison, so it does not
vary with the host locale or ICU data. The contract accepts only canonical UTC timestamps, an explicit valid IANA timezone,
non-negative counts, rates from zero through one, and internally consistent metadata coverage.
Missing or malformed required envelope context is rejected with an `AnalyticalResultContractError`;
callers do not need to interpret JavaScript property-access failures.
Each metadata-coverage denominator is the result's canonical `eventCount`, so an availability rate
always describes the same population as the analytical result. Analyses that later need coverage
over a narrower population must define and disclose that population in a new contract version.

This contract is deliberately analytical-only. It does not expose raw evidence, source paths,
account data, sensitive source fields, or private payloads. The common envelope rejects excluded
source and credential field names recursively in parameters and result payloads, including common
snake-case, kebab-case, and camel-case spellings. Each analysis must additionally define an
allowlisted payload shape for its own result before publishing an output.
