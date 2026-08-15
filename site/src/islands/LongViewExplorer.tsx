import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import type { PublicHistoryData } from "../adapters/public-snapshot.ts";
import { createLongViewPlot } from "../charts/long-view-plot.ts";
import {
  buildLongViewModel,
  buildLongViewState,
  parseLongViewState,
  type LongViewGrain,
  type LongViewMode,
} from "../view-models/long-view.ts";
import { formatMonth, formatNumber } from "../view-models/site.ts";

interface Props {
  readonly allowRange: boolean;
  readonly asOfDate: string | null;
  readonly canonicalEventCount: number;
  readonly history: PublicHistoryData;
  readonly route: "/" | "/explore/" | "/history/";
  readonly spotifyDurationEventCount: number;
}

export function LongViewExplorer({
  allowRange,
  asOfDate,
  canonicalEventCount,
  history,
  route,
  spotifyDurationEventCount,
}: Props) {
  const defaultGrain: LongViewGrain = route === "/history/" ? "year" : "month";
  const parse = (params: URLSearchParams) =>
    parseLongViewState(params, history.periods, { allowRange, defaultGrain });
  const [state, setState] = useState(() => parse(new URLSearchParams()));
  const chart = useRef<HTMLDivElement>(null);
  const model = useMemo(
    () => buildLongViewModel({ asOfDate, history }, state),
    [asOfDate, history, state],
  );

  useEffect(() => {
    const linkedState = parse(new URLSearchParams(window.location.search));
    setState(linkedState);
    updateCanonical(route, linkedState.canonicalSearch);
  }, [allowRange, history.periods, route]);

  useEffect(() => {
    const container = chart.current;
    if (container === null || model.periods.length === 0) return;
    const render = () => {
      const width = Math.floor(container.getBoundingClientRect().width || 840);
      container.replaceChildren(
        createLongViewPlot(model.periods, {
          description: `${formatNumber(model.totalPlayCount)} canonical plays from ${model.rangeLabel}. Bar colors provide source context; the findings and table repeat every distinction in text.`,
          width,
        }),
      );
    };
    render();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(render);
    observer.observe(container);
    return () => observer.disconnect();
  }, [model]);

  const update = (
    changes: Partial<{ from: string; grain: LongViewGrain; to: string; view: LongViewMode }>,
  ) => {
    setState((current) => {
      let from = changes.from ?? current.from;
      let to = changes.to ?? current.to;
      if (changes.from !== undefined && to !== null && changes.from > to) to = changes.from;
      if (changes.to !== undefined && from !== null && changes.to < from) from = changes.to;
      return buildLongViewState(history.periods, {
        allowRange,
        defaultGrain,
        from,
        grain: changes.grain ?? current.grain,
        to,
        view: changes.view ?? current.view,
      });
    });
  };
  const sharePath = `${route}${state.canonicalSearch}`;
  const durationRate =
    canonicalEventCount === 0 ? 0 : spotifyDurationEventCount / canonicalEventCount;
  const table = (
    <section
      class="table-region long-view__table"
      aria-labelledby="long-view-table-caption"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: The overflow region needs keyboard focus so arrow keys can reveal every column.
      tabIndex={0}
    >
      <p class="table-region__instruction">Scroll this table horizontally if needed.</p>
      <table id="long-view-table">
        <caption id="long-view-table-caption">
          Canonical plays and source context for {model.rangeLabel}
        </caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">Canonical plays</th>
            <th scope="col">Source context</th>
          </tr>
        </thead>
        <tbody>
          {model.periods.map((row) => (
            <tr key={row.period}>
              <th scope="row">{row.label}</th>
              <td>{formatNumber(row.playCount)}</td>
              <td>{row.coverageNote}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Selected total</th>
            <td>{formatNumber(model.totalPlayCount)}</td>
            <td>Canonical events counted once; source evidence is not added together.</td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
  const visual = (
    <figure class="chart-frame long-view__chart" aria-labelledby="long-view-chart-title">
      <figcaption>
        <p class="eyebrow">Visual evidence</p>
        <h3 id="long-view-chart-title">Canonical play count with source context</h3>
        <p>
          Bar height is full-history canonical play count. Bar color identifies the source context;
          it never changes the metric or substitutes evidence occurrences for plays.
        </p>
        <a href="#long-view-table">Skip to the equivalent data table</a>
      </figcaption>
      <div class="chart-frame__canvas long-view__plot" ref={chart}>
        <p>Interactive plotting is optional; the complete values and findings follow in HTML.</p>
      </div>
    </figure>
  );

  return (
    <div class="long-view">
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
          <legend>Shape the approved long view</legend>
          {allowRange && history.periods.length > 0 && (
            <>
              <label>
                From month
                <select
                  name="from"
                  value={state.from ?? ""}
                  onChange={(event) => update({ from: event.currentTarget.value })}
                >
                  {history.periods.map((row) => (
                    <option value={row.period} key={row.period}>
                      {formatMonth(row.period)}
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
                  {history.periods.map((row) => (
                    <option value={row.period} key={row.period}>
                      {formatMonth(row.period)}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label>
            Time grain
            <select
              name="grain"
              value={state.grain}
              onChange={(event) => update({ grain: event.currentTarget.value as LongViewGrain })}
            >
              <option value="month">Month</option>
              <option value="quarter">Quarter</option>
              <option value="year">Year</option>
            </select>
          </label>
          <label>
            Reading mode
            <select
              name="view"
              value={state.view}
              onChange={(event) => update({ view: event.currentTarget.value as LongViewMode })}
            >
              <option value="chart">Chart first</option>
              <option value="table">Table first</option>
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
          Showing <strong>{state.grain}</strong> canonical play counts from{" "}
          <strong>{model.rangeLabel}</strong>, <strong>{state.view}</strong> first.
        </p>
      </form>

      <section class="metric-boundary" aria-label="Metric coverage boundary">
        <div>
          <p class="eyebrow">Selected full-history metric</p>
          <h3>Canonical play count</h3>
          <p>{history.metricDefinition}</p>
        </div>
        <div>
          <p class="eyebrow">Not a full-history metric</p>
          <h3>Spotify-only duration</h3>
          <p>
            Duration exists for {formatNumber(spotifyDurationEventCount)} of{" "}
            {formatNumber(canonicalEventCount)} canonical events (
            {new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, style: "percent" }).format(
              durationRate,
            )}
            ). No listened-time or thresholded series is published in this contract, so neither
            appears as a control.
          </p>
        </div>
      </section>

      <section class="long-view__findings" aria-labelledby="long-view-findings-title">
        <p class="eyebrow">Read the finding without the chart</p>
        <h3 id="long-view-findings-title">What this range can—and cannot—say</h3>
        <ol>
          {model.findings.map((finding) => (
            <li>{finding}</li>
          ))}
        </ol>
      </section>

      {model.periods.length === 0 ? (
        <div class="state-panel state-panel--empty" role="status">
          <h3>No reviewed history rows</h3>
          <p>No zero timeline is invented. Coverage definitions remain available.</p>
        </div>
      ) : state.view === "table" ? (
        <>
          {table}
          {visual}
        </>
      ) : (
        <>
          {visual}
          {table}
        </>
      )}

      {model.sourceCoverage.length > 0 && (
        <section
          class="table-region long-view__coverage-table"
          aria-labelledby="coverage-table-caption"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The overflow region needs keyboard focus so arrow keys can reveal every column.
          tabIndex={0}
        >
          <p class="table-region__instruction">
            These are full-calendar-year source-evidence aggregates, not canonical play counts. When
            the selected range contains only part of a year, these totals include approved evidence
            from outside the selected months.
          </p>
          <table>
            <caption id="coverage-table-caption">
              Full-calendar-year source coverage for years intersecting the selected range
            </caption>
            <thead>
              <tr>
                <th scope="col">Year</th>
                <th scope="col">Last.fm evidence</th>
                <th scope="col">Spotify evidence</th>
                <th scope="col">Reconciled both-source events</th>
              </tr>
            </thead>
            <tbody>
              {model.sourceCoverage.map((row) => (
                <tr key={row.year}>
                  <th scope="row">{row.year}</th>
                  <td>
                    {row.lastfmEvidenceCount === null
                      ? "No listed evidence"
                      : formatNumber(row.lastfmEvidenceCount)}
                  </td>
                  <td>
                    {row.spotifyEvidenceCount === null
                      ? "No listed evidence"
                      : formatNumber(row.spotifyEvidenceCount)}
                  </td>
                  <td>{formatNumber(row.overlapEventCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <p class="share-state">
        Share this bounded public state:{" "}
        <a href={sharePath}>{new URL(sharePath, "https://music.the816.com").toString()}</a>. Public
        downloads are not authorized; the tables remain printable.
      </p>
    </div>
  );
}

function updateCanonical(route: Props["route"], search: string): void {
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (canonical) canonical.href = new URL(`${route}${search}`, canonical.href).toString();
}
