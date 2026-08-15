import { useEffect, useMemo, useState } from "preact/hooks";

import type { PublicArtistData } from "../adapters/public-snapshot.ts";
import {
  type ArtistDetailState,
  type ArtistDetailView,
  buildArtistDetailModel,
  buildArtistDetailState,
  formatComponentValue,
  parseArtistDetailState,
} from "../view-models/artist-eras.ts";
import { formatMonth, formatMonthRange, formatNumber, formatPercent } from "../view-models/site.ts";
import { ArtistComponentTable } from "./ArtistEraExplorer.tsx";

interface Props {
  readonly artist: PublicArtistData["artists"][number];
}

export function ArtistDetailExplorer({ artist }: Props) {
  const parse = (params: URLSearchParams) => parseArtistDetailState(params, artist);
  const [state, setState] = useState<ArtistDetailState>(() => parse(new URLSearchParams()));
  const model = useMemo(() => buildArtistDetailModel(artist, state), [artist, state]);
  const months = useMemo(() => artistMonths(artist), [artist]);
  const route = `/artists/${artist.slug}/`;

  useEffect(() => {
    const linked = parse(new URLSearchParams(window.location.search));
    setState(linked);
    updateCanonical(`${route}${linked.canonicalSearch}`);
  }, [artist, route]);

  const update = (changes: Partial<{ from: string; to: string; view: ArtistDetailView }>) => {
    setState((current) => {
      let from = changes.from ?? current.from;
      let to = changes.to ?? current.to;
      if (changes.from !== undefined && to !== null && changes.from > to) to = changes.from;
      if (changes.to !== undefined && from !== null && changes.to < from) from = changes.to;
      return buildArtistDetailState(artist, {
        from,
        to,
        view: changes.view ?? current.view,
      });
    });
  };
  const sharePath = `${route}${state.canonicalSearch}`;
  const intervalSummary = (
    <section class="artist-detail__intervals" aria-labelledby="artist-detail-intervals-title">
      <p class="eyebrow">Aggregate era context</p>
      <h3 id="artist-detail-intervals-title">Qualified intervals in this range</h3>
      <div class="artist-interval-cards">
        {model.intervalRows.map((row) => (
          <article key={`${row.startPeriod}-${row.endPeriodExclusive}`}>
            <p class="eyebrow">{formatMonthRange(row.startPeriod, row.endPeriodExclusive)}</p>
            <h4>{formatNumber(row.playCount)} aggregate qualifying-window plays</h4>
            <dl>
              <div>
                <dt>Peak</dt>
                <dd>{formatMonth(row.peak.period)}</dd>
              </div>
              <div>
                <dt>Strength</dt>
                <dd>{formatPercent(row.strength)}</dd>
              </div>
              <div>
                <dt>Share</dt>
                <dd>{formatPercent(row.share)}</dd>
              </div>
              <div>
                <dt>Evidence windows</dt>
                <dd>{formatNumber(row.evidence.length)}</dd>
              </div>
            </dl>
            <p>
              {row.evidence.length <= 2
                ? "Sparse public evidence: this interval remains qualified, but its small window count stays explicit."
                : "This is a bounded aggregate interval under the published parameters, not a permanent artist label."}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
  const periodTable = <ArtistPeriodTable artist={artist} rows={model.evidenceRows} />;
  const components = (
    <ArtistComponentTable rows={model.evidenceRows} id="artist-detail-component-table" />
  );

  return (
    <div class="artist-detail">
      <form
        class="filter-panel"
        action={route}
        method="get"
        onSubmit={(event) => {
          event.preventDefault();
          window.location.assign(sharePath);
        }}
      >
        <fieldset>
          <legend>Inspect approved aggregate evidence</legend>
          {months.length > 0 && (
            <>
              <label>
                From month
                <select
                  name="from"
                  value={state.from ?? ""}
                  onChange={(event) => update({ from: event.currentTarget.value })}
                >
                  {months.map((month) => (
                    <option value={month} key={month}>
                      {formatMonth(month)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Through month
                <select
                  name="to"
                  value={state.to ?? ""}
                  onChange={(event) => update({ to: event.currentTarget.value })}
                >
                  {months.map((month) => (
                    <option value={month} key={month}>
                      {formatMonth(month)}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label>
            Reading mode
            <select
              name="view"
              value={state.view}
              onChange={(event) => update({ view: event.currentTarget.value as ArtistDetailView })}
            >
              <option value="summary">Summary first</option>
              <option value="components">Components first</option>
              <option value="table">Period table first</option>
            </select>
          </label>
          <button type="submit">Apply view</button>
        </fieldset>
        {state.notice && (
          <p class="filter-panel__notice" role="status">
            {state.notice}
          </p>
        )}
        <p class="filter-panel__summary" aria-live="polite">
          Showing {artist.displayName}'s approved intervals intersecting {model.rangeLabel},{" "}
          <strong>{state.view}</strong> first. Interval totals and component evidence remain whole.
        </p>
      </form>

      <section class="artist-findings" aria-labelledby="artist-detail-findings-title">
        <p class="eyebrow">Analytical finding</p>
        <h3 id="artist-detail-findings-title">What qualified this public view</h3>
        <ol>
          {model.findings.map((finding) => (
            <li>{finding}</li>
          ))}
        </ol>
      </section>

      {model.intervalRows.length === 0 ? (
        <div class="state-panel state-panel--empty" role="status">
          <h3>No interval intersects this range</h3>
          <p>Choose another approved month range. No individual play history is available here.</p>
        </div>
      ) : state.view === "components" ? (
        <>
          {components}
          {intervalSummary}
          {periodTable}
        </>
      ) : state.view === "table" ? (
        <>
          {periodTable}
          {intervalSummary}
          {components}
        </>
      ) : (
        <>
          {intervalSummary}
          {periodTable}
          {components}
        </>
      )}

      <p class="share-state">
        Share this eligible artist state:{" "}
        <a href={sharePath}>{new URL(sharePath, "https://music.the816.com").toString()}</a>. This
        route contains period aggregates only—never individual plays or arbitrary track history.
      </p>
    </div>
  );
}

function ArtistPeriodTable({
  artist,
  rows,
}: {
  readonly artist: PublicArtistData["artists"][number];
  readonly rows: readonly {
    readonly components: PublicArtistData["artists"][number]["intervals"][number]["evidence"][number]["components"];
    readonly period: string;
  }[];
}) {
  return (
    <section
      class="table-region"
      aria-labelledby="artist-period-table-caption"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard focus lets arrow keys reveal every column.
      tabIndex={0}
    >
      <p class="table-region__instruction">
        One row per approved qualifying window in each intersecting interval. Complete interval
        evidence stays together so the displayed aggregate reconciles; these rows cannot reconstruct
        individual listens.
      </p>
      <table id="artist-period-table">
        <caption id="artist-period-table-caption">
          Public period summaries for {artist.displayName}
        </caption>
        <thead>
          <tr>
            <th scope="col">Window period</th>
            <th scope="col">Window plays</th>
            <th scope="col">Rolling plays</th>
            <th scope="col">Listening share</th>
            <th scope="col">Rank</th>
            <th scope="col">Strength</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.period}>
              <th scope="row">{formatMonth(row.period)}</th>
              <td>{formatNumber(row.components.windowPlayCount)}</td>
              <td>{formatNumber(row.components.rollingPlayCount)}</td>
              <td>{formatPercent(row.components.listeningShare)}</td>
              <td>{formatNumber(row.components.rank)}</td>
              <td>{formatComponentValue("strength", row.components.strength)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function artistMonths(artist: PublicArtistData["artists"][number]): readonly string[] {
  const starts = artist.intervals.map((interval) => interval.startPeriod).toSorted();
  const ends = artist.intervals.map((interval) => interval.endPeriodExclusive).toSorted();
  const first = starts[0];
  const endExclusive = ends.at(-1);
  if (first === undefined || endExclusive === undefined) return [];
  const firstOrdinal = monthOrdinal(first);
  const lastOrdinal = monthOrdinal(endExclusive) - 1;
  return Array.from({ length: lastOrdinal - firstOrdinal + 1 }, (_, index) =>
    monthFromOrdinal(firstOrdinal + index),
  );
}

function monthOrdinal(month: string): number {
  const [year, monthNumber] = month.split("-").map(Number);
  return (year ?? 0) * 12 + (monthNumber ?? 1) - 1;
}

function monthFromOrdinal(ordinal: number): string {
  const year = Math.floor(ordinal / 12);
  const month = (ordinal % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function updateCanonical(path: string): void {
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (canonical) canonical.href = new URL(path, canonical.href).toString();
}
