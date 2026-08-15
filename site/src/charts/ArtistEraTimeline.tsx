import type { ArtistEraRow } from "../view-models/artist-eras.ts";
import { formatMonth, formatPercent } from "../view-models/site.ts";

interface Props {
  readonly from: string | null;
  readonly rows: readonly ArtistEraRow[];
  readonly to: string | null;
}

export function ArtistEraTimeline({ from, rows, to }: Props) {
  if (from === null || to === null) return null;
  const left = 190;
  const width = 960;
  const plotWidth = width - left - 28;
  const start = monthOrdinal(from);
  const endExclusive = monthOrdinal(to) + 1;
  const span = Math.max(1, endExclusive - start);
  const rowHeight = 52;
  const top = 54;
  const height = top + rows.length * rowHeight + 44;
  const x = (month: string) => left + ((monthOrdinal(month) - start) / span) * plotWidth;
  const ticks = tickMonths(from, to, 8);

  return (
    <figure class="chart-frame artist-timeline" aria-labelledby="artist-era-chart-title">
      <figcaption>
        <p class="eyebrow">Visual evidence</p>
        <h3 id="artist-era-chart-title">Eligible artist intervals, peaks, and overlaps</h3>
        <p>
          Horizontal position shows time; bar length shows the qualified interval; bar height shows
          strength; the diamond marks the peak. Concurrent rows retain overlaps rather than choosing
          one winner. Every value is repeated in the tables.
        </p>
        <a href="#artist-interval-table">Skip to the equivalent interval table</a>
      </figcaption>
      <div
        class="chart-frame__canvas artist-timeline__canvas"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard focus lets arrow keys pan the responsive SVG at narrow widths.
        tabIndex={0}
      >
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${rows.length} eligible artist-era intervals from ${formatMonth(from)} through ${formatMonth(to)}. The following findings and tables provide all values.`}
        >
          <title>Eligible artist-era intervals</title>
          <desc>
            Each row is one approved aggregate interval. Diamonds mark analytical peaks. Overlap is
            preserved. Read the adjacent tables for exact component evidence.
          </desc>
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={x(tick)}
                x2={x(tick)}
                y1={34}
                y2={height - 24}
                class="artist-timeline__grid"
              />
              <text x={x(tick)} y={22} text-anchor="middle" class="artist-timeline__tick">
                {formatMonth(tick)}
              </text>
            </g>
          ))}
          {rows.map((row, index) => {
            const y = top + index * rowHeight;
            const rowStart = Math.max(start, monthOrdinal(row.startPeriod));
            const rowEnd = Math.min(endExclusive, monthOrdinal(row.endPeriodExclusive));
            const barHeight = 10 + row.strength * 18;
            const peakInRange = row.peak.period >= from && row.peak.period <= to;
            return (
              <g key={`${row.artistSlug}-${row.startPeriod}-${row.endPeriodExclusive}`}>
                <text x={left - 12} y={y + 5} text-anchor="end" class="artist-timeline__label">
                  {row.artistDisplayName}
                </text>
                <line x1={left} x2={width - 28} y1={y} y2={y} class="artist-timeline__row" />
                <rect
                  x={left + ((rowStart - start) / span) * plotWidth}
                  y={y - barHeight / 2}
                  width={Math.max(3, ((rowEnd - rowStart) / span) * plotWidth)}
                  height={barHeight}
                  rx={2}
                  class={
                    row.overlapCount > 0
                      ? "artist-timeline__bar is-overlap"
                      : "artist-timeline__bar"
                  }
                />
                {peakInRange && (
                  <rect
                    x={x(row.peak.period) - 5}
                    y={y - 5}
                    width={10}
                    height={10}
                    transform={`rotate(45 ${x(row.peak.period)} ${y})`}
                    class="artist-timeline__peak"
                  />
                )}
                <text x={width - 20} y={y + 5} text-anchor="end" class="artist-timeline__value">
                  {formatPercent(row.strength)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </figure>
  );
}

function tickMonths(from: string, to: string, maximumTicks: number): readonly string[] {
  const first = monthOrdinal(from);
  const last = monthOrdinal(to);
  const step = Math.max(1, Math.ceil((last - first + 1) / maximumTicks));
  const ticks: string[] = [];
  for (let current = first; current <= last; current += step) ticks.push(monthFromOrdinal(current));
  if (ticks.at(-1) !== to) ticks.push(to);
  return ticks;
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
