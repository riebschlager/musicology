import type { StoryEvidenceRow, StoryViewModel } from "../view-models/stories.ts";

export function StoryEvidenceCard({ story }: { readonly story: StoryViewModel }) {
  return (
    <article class={`story-evidence-card story-evidence-card--${story.kind}`} id={story.slug}>
      <div class="story-evidence-card__heading">
        <p class="eyebrow">{story.kindLabel}</p>
        <p class="story-evidence-card__period">{story.periodLabel}</p>
      </div>
      <h3>{story.title}</h3>
      <p>{story.summary}</p>
      {story.selectedTrackLabel !== null && (
        <p class="story-evidence-card__track">
          <span aria-hidden="true">♪</span> {story.selectedTrackLabel}
        </p>
      )}
      <div class="story-classification">
        <p class="eyebrow">Published classification</p>
        <p>
          <strong>{story.classificationLabel}</strong> · {story.classificationExplanation}
        </p>
      </div>
      <StorySupersession story={story} />
      <ul class="story-warning-list" aria-label="Evidence qualifications">
        {story.warnings.map((warning) => (
          <li>{warning}</li>
        ))}
      </ul>
      <details class="story-evidence-card__details">
        <summary>Inspect every approved evidence value and parameter</summary>
        <StoryEvidenceTables story={story} idPrefix={`story-card-${story.slug}`} />
      </details>
      <p class="story-evidence-card__link">
        <a href={`/stories/${story.slug}/`}>Read the reviewed story and evidence</a>
      </p>
    </article>
  );
}

export function StorySupersession({ story }: { readonly story: StoryViewModel }) {
  if (story.supersedesStory === null && story.supersededByStories.length === 0) return null;

  return (
    <aside class="story-supersession" aria-label="Supersession history">
      <p class="eyebrow">Conclusion history</p>
      {story.supersedesStory !== null && (
        <p>
          This story supersedes the earlier {story.supersedesStory.kindLabel.toLowerCase()}{" "}
          <a href={`/stories/${story.supersedesStory.slug}/`}>{story.supersedesStory.title}</a>.
        </p>
      )}
      {story.supersededByStories.map((later) => (
        <p>
          Superseded by the later approved {later.kindLabel.toLowerCase()}{" "}
          <a href={`/stories/${later.slug}/`}>{later.title}</a>. This earlier conclusion remains
          visible with its original evidence.
        </p>
      ))}
    </aside>
  );
}

export function StoryEvidenceTables({
  idPrefix,
  story,
}: {
  readonly idPrefix: string;
  readonly story: StoryViewModel;
}) {
  return (
    <div class="story-evidence-tables">
      <StoryValueTable
        caption="Approved evidence"
        id={`${idPrefix}-evidence`}
        rows={story.evidenceRows}
      />
      <StoryValueTable
        caption="Published classification parameters"
        id={`${idPrefix}-parameters`}
        rows={story.parameterRows}
      />
    </div>
  );
}

function StoryValueTable({
  caption,
  id,
  rows,
}: {
  readonly caption: string;
  readonly id: string;
  readonly rows: readonly StoryEvidenceRow[];
}) {
  return (
    <section
      class="table-region"
      aria-labelledby={`${id}-caption`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard focus lets arrow keys reveal every column.
      tabIndex={0}
    >
      <p class="table-region__instruction">Every value below is reduced and allowlisted.</p>
      <table id={id}>
        <caption id={`${id}-caption`}>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Measure</th>
            <th scope="col">Published value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td>{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
