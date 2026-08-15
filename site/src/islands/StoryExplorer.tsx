import { useEffect, useMemo, useState } from "preact/hooks";

import type { PublicStoryData } from "../adapters/public-snapshot.ts";
import { StoryEvidenceCard } from "../components/StoryEvidence.tsx";
import {
  type StoryExplorerState,
  type StoryKindFilter,
  type StoryView,
  buildStoryExplorerModel,
  buildStoryExplorerState,
  parseStoryExplorerState,
} from "../view-models/stories.ts";
import { formatMonth, formatNumber } from "../view-models/site.ts";

interface Props {
  readonly asOfDate: string | null;
  readonly data: PublicStoryData;
}

export function StoryExplorer({ asOfDate, data }: Props) {
  const parse = (params: URLSearchParams) => parseStoryExplorerState(params, data.stories);
  const [state, setState] = useState<StoryExplorerState>(() => parse(new URLSearchParams()));
  const model = useMemo(
    () => buildStoryExplorerModel(data, state, asOfDate),
    [asOfDate, data, state],
  );

  useEffect(() => {
    const linked = parse(new URLSearchParams(window.location.search));
    setState(linked);
    updateCanonical(`/stories/${linked.canonicalSearch}`);
  }, [data.stories]);

  const update = (
    changes: Partial<{ from: string; kind: StoryKindFilter; to: string; view: StoryView }>,
  ) => {
    setState((current) => {
      let from = changes.from ?? current.from;
      let to = changes.to ?? current.to;
      if (changes.from !== undefined && to !== null && changes.from > to) to = changes.from;
      if (changes.to !== undefined && from !== null && changes.to < from) from = changes.to;
      return buildStoryExplorerState(data.stories, {
        from,
        kind: changes.kind ?? current.kind,
        to,
        view: changes.view ?? current.view,
      });
    });
  };
  const sharePath = `/stories/${state.canonicalSearch}`;
  const cards = (
    <div class="story-evidence-grid">
      {model.stories.map((story) => (
        <StoryEvidenceCard key={story.slug} story={story} />
      ))}
    </div>
  );
  const list = <StoryIndexTable stories={model.stories} />;

  return (
    <div class="story-explorer">
      <form
        class="filter-panel"
        action="/stories/"
        method="get"
        onSubmit={(event) => {
          event.preventDefault();
          window.location.assign(sharePath);
        }}
      >
        <fieldset>
          <legend>Filter the reviewed story sequence</legend>
          <label>
            Story kind
            <select
              name="kind"
              value={state.kind}
              onChange={(event) => update({ kind: event.currentTarget.value as StoryKindFilter })}
            >
              <option value="all">All reviewed stories</option>
              <option value="rediscovery">Returns only</option>
              <option value="dormancy">Dormancy only</option>
            </select>
          </label>
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
              onChange={(event) => update({ view: event.currentTarget.value as StoryView })}
            >
              <option value="cards">Story cards first</option>
              <option value="list">Compact list first</option>
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
          Showing <strong>{formatNumber(model.stories.length)}</strong> reviewed{" "}
          {state.kind === "all" ? "return and dormancy" : state.kind} stor
          {model.stories.length === 1 ? "y" : "ies"} from <strong>{model.rangeLabel}</strong>,{" "}
          <strong>{state.view}</strong> first.
        </p>
      </form>

      <section class="story-findings" aria-labelledby="story-findings-title">
        <p class="eyebrow">Read the conclusions without the cards</p>
        <h3 id="story-findings-title">What this selection can say</h3>
        <ol>
          {model.findings.map((finding) => (
            <li>{finding}</li>
          ))}
        </ol>
      </section>

      {model.stories.length === 0 ? (
        <div class="state-panel state-panel--empty" role="status">
          <h3>No reviewed stories in this view</h3>
          <p>
            Choose another public kind or period. No unreviewed return, dormancy candidate, artist,
            or track name is loaded as a fallback.
          </p>
        </div>
      ) : state.view === "list" ? (
        <>
          {list}
          {cards}
        </>
      ) : (
        <>
          {cards}
          {list}
        </>
      )}

      <p class="share-state">
        Share this bounded public state:{" "}
        <a href={sharePath}>{new URL(sharePath, "https://music.the816.com").toString()}</a>. The
        browser receives only editorially selected stories and the eligible public cohort.
      </p>
    </div>
  );
}

function StoryIndexTable({
  stories,
}: {
  readonly stories: ReturnType<typeof buildStoryExplorerModel>["stories"];
}) {
  return (
    <section
      class="table-region story-index-table"
      aria-labelledby="story-index-table-caption"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard focus lets arrow keys reveal every column.
      tabIndex={0}
    >
      <p class="table-region__instruction">
        This index contains reviewed stories only. Track text appears only where the manual
        editorial allowlist supplied it.
      </p>
      <table id="story-index-table">
        <caption id="story-index-table-caption">Reviewed return and dormancy story index</caption>
        <thead>
          <tr>
            <th scope="col">Story</th>
            <th scope="col">Kind</th>
            <th scope="col">Approved period</th>
            <th scope="col">Classification</th>
            <th scope="col">Selected track</th>
            <th scope="col">Conclusion history</th>
          </tr>
        </thead>
        <tbody>
          {stories.map((story) => (
            <tr key={story.slug}>
              <th scope="row">
                <a href={`/stories/${story.slug}/`}>{story.title}</a>
              </th>
              <td>{story.kindLabel}</td>
              <td>{story.periodLabel}</td>
              <td>{story.classificationLabel}</td>
              <td>{story.selectedTrackLabel ?? "No selected track identity"}</td>
              <td>
                {story.supersededByStories.length > 0
                  ? `Superseded by ${story.supersededByStories.map((entry) => entry.title).join(", ")}`
                  : story.supersedesStory === null
                    ? "Current in this approved story set"
                    : `Supersedes ${story.supersedesStory.title}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function updateCanonical(path: string): void {
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (canonical) canonical.href = new URL(path, canonical.href).toString();
}
