import * as Plot from "@observablehq/plot";

import type { LongViewPeriod } from "../view-models/long-view.ts";

export function createLongViewPlot(
  rows: readonly LongViewPeriod[],
  options: { readonly description: string; readonly width: number },
): HTMLElement | SVGSVGElement {
  const plot = Plot.plot({
    ariaDescription: options.description,
    ariaLabel: "Canonical play count over time with source coverage context",
    color: {
      domain: [
        "Both sources in year",
        "Last.fm in year",
        "Spotify in year",
        "Source gap or boundary",
      ],
      legend: true,
      range: ["#173f3a", "#bdcb2d", "#c94023", "#6d6258"],
    },
    height: 360,
    marginBottom: rows.length > 40 ? 72 : 56,
    marks: [
      Plot.barY(rows, {
        fill: "coverageCategory",
        tip: true,
        title: (row) => `${row.label}\n${row.playCount} canonical plays\n${row.coverageNote}`,
        x: "label",
        y: "playCount",
      }),
      Plot.ruleY([0]),
    ],
    style: {
      background: "transparent",
      color: "#17201e",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: "11px",
    },
    width: Math.max(280, options.width),
    x: {
      label: "Period",
      tickRotate: rows.length > 8 ? -45 : 0,
      ticks: Math.min(rows.length, 14),
    },
    y: { grid: true, label: "Canonical plays", nice: true },
  });
  // Plot labels its internal SVG groups even though those groups have no valid ARIA role. The
  // outer SVG already owns the chart name/description, and the adjacent HTML table owns every
  // value, so hide the redundant implementation groups from assistive technology.
  for (const group of plot.querySelectorAll("g[aria-label]")) {
    group.removeAttribute("aria-label");
    group.setAttribute("aria-hidden", "true");
  }
  return plot;
}
