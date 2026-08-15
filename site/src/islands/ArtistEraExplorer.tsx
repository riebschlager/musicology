import { useEffect, useMemo, useState } from "preact/hooks";

import type { PublicArtistData } from "../adapters/public-snapshot.ts";
import { ArtistEraTimeline } from "../charts/ArtistEraTimeline.tsx";
import {
  type ArtistEraRow,
  type ArtistEraState,
  type ArtistEraView,
  buildArtistEraModel,
  buildArtistEraState,
  formatComponentValue,
  MAX_ARTIST_COMPARISON,
  parseArtistEraState,
} from "../view-models/artist-eras.ts";
import { formatMonth, formatMonthRange, formatNumber, formatPercent } from "../view-models/site.ts";

interface Props {
  readonly data: PublicArtistData;
}

export function ArtistEraExplorer({ data }: Props) {
  const parse = (params: URLSearchParams) => parseArtistEraState(params, data.artists);
  const [state, setState] = useState<ArtistEraState>(() => parse(new URLSearchParams()));
  const [search, setSearch] = useState("");
  const model = useMemo(() => buildArtistEraModel(data, state), [data, state]);
  const matchingArtists = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("en-US");
    return query.length === 0
      ? data.artists
      : data.artists.filter((artist) =>
          artist.displayName.toLocaleLowerCase("en-US").includes(query),
        );
  }, [data.artists, search]);

  useEffect(() => {
    const linked = parse(new URLSearchParams(window.location.search));
    setState(linked);
    updateCanonical(`/artists/${linked.canonicalSearch}`);
  }, [data.artists]);

  const update = (
    changes: Partial<{
      artistSlugs: readonly string[];
      from: string;
      to: string;
      view: ArtistEraView;
    }>,
  ) => {
    setState((current) => {
      let from = changes.from ?? current.from;
      let to = changes.to ?? current.to;
      if (changes.from !== undefined && to !== null && changes.from > to) to = changes.from;
      if (changes.to !== undefined && from !== null && changes.to < from) from = changes.to;
      return buildArtistEraState(data.artists, {
        artistSlugs: changes.artistSlugs ?? current.artistSlugs,
        from,
        to,
        view: changes.view ?? current.view,
      });
    });
  };
  const toggleArtist = (slug: string) => {
    const next = state.artistSlugs.includes(slug)
      ? state.artistSlugs.filter((selected) => selected !== slug)
      : [...state.artistSlugs, slug];
    if (next.length <= MAX_ARTIST_COMPARISON) update({ artistSlugs: next });
  };
  const sharePath = `/artists/${state.canonicalSearch}`;
  const intervalTable = <ArtistIntervalTable rows={model.rows} />;
  const timeline = <ArtistEraTimeline rows={model.rows} from={state.from} to={state.to} />;

  return (
    <div class="artist-era-explorer">
      <form
        class="filter-panel artist-filter"
        action="/artists/"
        method="get"
        onSubmit={(event) => {
          event.preventDefault();
          window.location.assign(sharePath);
        }}
      >
        <fieldset>
          <legend>Compare only the eligible public cohort</legend>
          {model.bounds !== null && (
            <>
              <label>
                From month
                <select
                  name="from"
                  value={state.from ?? ""}
                  onChange={(event) => update({ from: event.currentTarget.value })}
                >
                  {model.bounds.months.map((month) => (
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
                  {model.bounds.months.map((month) => (
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
              onChange={(event) => update({ view: event.currentTarget.value as ArtistEraView })}
            >
              <option value="timeline">Timeline first</option>
              <option value="table">Table first</option>
            </select>
          </label>
          <button type="submit">Apply view</button>
        </fieldset>

        {data.artists.length > 0 && (
          <div class="artist-filter__cohort">
            <label>
              Search eligible artists
              <input
                type="search"
                value={search}
                onInput={(event) => setSearch(event.currentTarget.value)}
                placeholder="Search this public cohort"
              />
            </label>
            <fieldset>
              <legend>
                Focus a comparison (up to {MAX_ARTIST_COMPARISON}; none means the full public
                cohort)
              </legend>
              <div class="artist-filter__choices">
                {matchingArtists.map((artist) => {
                  const selected = state.artistSlugs.includes(artist.slug);
                  return (
                    <label key={artist.slug}>
                      <input
                        type="checkbox"
                        name="artist"
                        value={artist.slug}
                        checked={selected}
                        disabled={!selected && state.artistSlugs.length >= MAX_ARTIST_COMPARISON}
                        onChange={() => toggleArtist(artist.slug)}
                      />
                      {artist.displayName}
                    </label>
                  );
                })}
              </div>
            </fieldset>
            {matchingArtists.length === 0 && (
              <p role="status">No eligible public artist matches that search.</p>
            )}
            {state.artistSlugs.length > 0 && (
              <button
                class="artist-filter__reset"
                type="button"
                onClick={() => update({ artistSlugs: [] })}
              >
                Return to the full public cohort
              </button>
            )}
          </div>
        )}

        {state.notice && (
          <p class="filter-panel__notice" role="status">
            {state.notice}
          </p>
        )}
        <p class="filter-panel__summary" aria-live="polite">
          Showing <strong>{formatNumber(model.rows.length)}</strong> eligible interval
          {model.rows.length === 1 ? "" : "s"} from <strong>{model.rangeLabel}</strong>,{" "}
          <strong>{state.view}</strong> first.
        </p>
      </form>

      <section class="artist-findings" aria-labelledby="artist-findings-title">
        <p class="eyebrow">Read the signals without the timeline</p>
        <h3 id="artist-findings-title">What this selection can say</h3>
        <ol>
          {model.findings.map((finding) => (
            <li>{finding}</li>
          ))}
        </ol>
      </section>

      {model.rows.length === 0 ? (
        <div class="state-panel state-panel--empty" role="status">
          <h3>No eligible intervals in this view</h3>
          <p>
            Reset the public filters to continue. No suppressed name or private long-tail count is
            loaded or revealed.
          </p>
        </div>
      ) : state.view === "table" ? (
        <>
          {intervalTable}
          {timeline}
        </>
      ) : (
        <>
          {timeline}
          {intervalTable}
        </>
      )}

      {model.evidenceRows.length > 0 && (
        <ArtistComponentTable rows={model.evidenceRows} id="artist-component-table" />
      )}

      <p class="share-state">
        Share this bounded public state:{" "}
        <a href={sharePath}>{new URL(sharePath, "https://music.the816.com").toString()}</a>. The
        browser receives only artists already admitted by the reviewed public snapshot.
      </p>
    </div>
  );
}

function ArtistIntervalTable({ rows }: { readonly rows: readonly ArtistEraRow[] }) {
  return (
    <section
      class="table-region"
      aria-labelledby="artist-interval-table-caption"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard focus lets arrow keys reveal all table columns.
      tabIndex={0}
    >
      <p class="table-region__instruction">Scroll this table horizontally if needed.</p>
      <table id="artist-interval-table">
        <caption id="artist-interval-table-caption">
          Eligible aggregate artist intervals in the selected public range
        </caption>
        <thead>
          <tr>
            <th scope="col">Artist</th>
            <th scope="col">Interval</th>
            <th scope="col">Peak</th>
            <th scope="col">Plays</th>
            <th scope="col">Share</th>
            <th scope="col">Strength</th>
            <th scope="col">Overlap</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.artistSlug}-${row.startPeriod}-${row.endPeriodExclusive}`}>
              <th scope="row">{row.artistDisplayName}</th>
              <td>{formatMonthRange(row.startPeriod, row.endPeriodExclusive)}</td>
              <td>{formatMonth(row.peak.period)}</td>
              <td>{formatNumber(row.playCount)}</td>
              <td>{formatPercent(row.share)}</td>
              <td>{formatPercent(row.strength)}</td>
              <td>
                {row.overlapCount === 0
                  ? "No displayed overlap"
                  : `${formatNumber(row.overlapCount)} concurrent signal${row.overlapCount === 1 ? "" : "s"}`}
              </td>
              <td>
                <a href={`/artists/${row.artistSlug}/`}>Open aggregate artist detail</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function ArtistComponentTable({
  id,
  rows,
}: {
  readonly id: string;
  readonly rows: readonly {
    readonly artistDisplayName: string;
    readonly artistSlug: string;
    readonly components: PublicArtistData["artists"][number]["intervals"][number]["evidence"][number]["components"];
    readonly intervalLabel: string;
    readonly period: string;
  }[];
}) {
  return (
    <section
      class="table-region artist-components"
      aria-labelledby={`${id}-caption`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard focus lets arrow keys reveal all table columns.
      tabIndex={0}
    >
      <p class="table-region__instruction">
        These are every approved aggregate window component for the displayed intervals, not
        individual plays. Follow an artist-period link to its matching comparison state, or scroll
        horizontally if needed.
      </p>
      <table id={id}>
        <caption id={`${id}-caption`}>
          Component evidence for every displayed interval window
        </caption>
        <thead>
          <tr>
            <th scope="col">Artist / period</th>
            <th scope="col">Window plays</th>
            <th scope="col">Rolling plays</th>
            <th scope="col">Share</th>
            <th scope="col">Rank</th>
            <th scope="col">Consecutive windows</th>
            <th scope="col">Earlier baseline</th>
            <th scope="col">Change from baseline</th>
            <th scope="col">Strength</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.artistSlug}-${row.intervalLabel}-${row.period}`}>
              <th scope="row">
                <a href={componentStatePath(row)}>
                  {row.artistDisplayName} · {formatMonth(row.period)}
                </a>
              </th>
              <td>{formatComponentValue("windowPlayCount", row.components.windowPlayCount)}</td>
              <td>{formatComponentValue("rollingPlayCount", row.components.rollingPlayCount)}</td>
              <td>{formatComponentValue("listeningShare", row.components.listeningShare)}</td>
              <td>{formatComponentValue("rank", row.components.rank)}</td>
              <td>
                {formatComponentValue(
                  "consecutiveActiveWindows",
                  row.components.consecutiveActiveWindows,
                )}
              </td>
              <td>
                {formatComponentValue(
                  "earlierBaselineRollingPlayCount",
                  row.components.earlierBaselineRollingPlayCount,
                )}
              </td>
              <td>
                {formatComponentValue(
                  "earlierBaselineChange",
                  row.components.earlierBaselineChange,
                )}
              </td>
              <td>{formatComponentValue("strength", row.components.strength)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function componentStatePath(row: { readonly artistSlug: string; readonly period: string }): string {
  const params = new URLSearchParams();
  params.set("from", row.period);
  params.set("to", row.period);
  params.set("artist", row.artistSlug);
  params.set("view", "table");
  return `/artists/?${params.toString()}`;
}

function updateCanonical(path: string): void {
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (canonical) canonical.href = new URL(path, canonical.href).toString();
}
