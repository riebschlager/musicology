import { useEffect, useState } from "preact/hooks";

import {
  buildExplorerState,
  parseExplorerState,
  type ExplorerGrain,
  type ExplorerState,
  type ExplorerView,
} from "../view-models/site.ts";

interface Props {
  readonly defaultState: ExplorerState;
}

export function ExplorerFilter({ defaultState }: Props) {
  const [state, setState] = useState(defaultState);

  useEffect(() => {
    const linkedState = parseExplorerState(new URLSearchParams(window.location.search));
    setState(linkedState);
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (canonical) {
      canonical.href = new URL(
        `/explore/${linkedState.canonicalSearch}`,
        canonical.href,
      ).toString();
    }
  }, []);

  const shareUrl = new URL(
    `/explore/${state.canonicalSearch}`,
    "https://music.the816.com",
  ).toString();

  return (
    <div>
      <form class="filter-panel" action="/explore/" method="get">
        <fieldset>
          <legend>Shape this public view</legend>
          <label>
            Time grain
            <select
              name="grain"
              value={state.grain}
              onChange={(event) =>
                setState((current) =>
                  buildExplorerState(event.currentTarget.value as ExplorerGrain, current.view),
                )
              }
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
              onChange={(event) =>
                setState((current) =>
                  buildExplorerState(current.grain, event.currentTarget.value as ExplorerView),
                )
              }
            >
              <option value="chart">Chart with table</option>
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
          Current state: <strong>{state.grain}</strong> grain, <strong>{state.view}</strong> first.
        </p>
      </form>
      <p class="share-state">
        Share this state: <a href={`/explore/${state.canonicalSearch}`}>{shareUrl}</a>
      </p>
    </div>
  );
}
