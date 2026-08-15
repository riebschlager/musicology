import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const routes = [
  "/",
  "/history/",
  "/artists/",
  "/artists/synthetic-eligible-artist/",
  "/artists/synthetic-overlap-artist/",
  "/stories/",
  "/explore/",
  "/methodology/",
  "/404.html",
];

for (const route of routes) {
  test(`${route} has an accessible static shell`, async ({ page }) => {
    const externalRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.origin !== "http://127.0.0.1:4321") externalRequests.push(request.url());
    });

    await page.goto(route);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect(page.locator("link[rel='canonical']")).toHaveAttribute(
      "href",
      /^https:\/\/music\.the816\.com\//u,
    );
    expect(externalRequests).toEqual([]);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
}

test("skip navigation and explorer controls work from the keyboard", async ({ page }) => {
  await page.goto("/explore/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();

  await page.getByLabel("Time grain").selectOption("year");
  await page.getByLabel("Reading mode").selectOption("table");
  await page.getByRole("button", { name: "Apply view" }).click();
  await expect(page).toHaveURL(/\/explore\/\?grain=year&view=table$/u);
  await expect(page.locator(".filter-panel__summary")).toContainText(
    "Showing year canonical play counts",
  );
  await expect(page.locator("link[rel='canonical']")).toHaveAttribute(
    "href",
    "https://music.the816.com/explore/?grain=year&view=table",
  );
});

test("invalid explorer state falls back visibly without reflecting the rejected value", async ({
  page,
}) => {
  await page.goto("/explore/?grain=day&artist=private-tail");
  await expect(
    page.getByRole("status").filter({ hasText: "Unsupported or out-of-range link options" }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("private-tail");
  await expect(page.locator("link[rel='canonical']")).toHaveAttribute(
    "href",
    "https://music.the816.com/explore/",
  );
});

test("bounded history URL state reconciles its visible total and table-first order", async ({
  page,
}) => {
  await page.goto("/history/?from=2020-04&to=2020-09&grain=quarter&view=table");
  await expect(page.locator(".filter-panel__summary")).toContainText(
    "Showing quarter canonical play counts from Apr 2020–Sep 2020",
  );
  await expect(page.locator("#long-view-table tfoot")).toContainText("24");
  await expect(page.locator(".long-view__coverage-table")).toContainText(
    "full-calendar-year source-evidence aggregates",
  );
  await expect(page.locator(".long-view__coverage-table")).toContainText(
    "outside the selected months",
  );
  expect(
    await page
      .locator(".long-view__table")
      .evaluate(
        (table, chart) =>
          Boolean(table.compareDocumentPosition(chart as Node) & Node.DOCUMENT_POSITION_FOLLOWING),
        await page.locator(".long-view__chart").elementHandle(),
      ),
  ).toBe(true);
  await expect(page.locator("link[rel='canonical']")).toHaveAttribute(
    "href",
    "https://music.the816.com/history/?from=2020-04&to=2020-09&grain=quarter&view=table",
  );
});

test("history defaults to the documented yearly canonical state", async ({ page }) => {
  await page.goto("/history/");
  await expect(page.locator(".filter-panel__summary")).toContainText(
    "Showing year canonical play counts",
  );
  await expect(page.locator("link[rel='canonical']")).toHaveAttribute(
    "href",
    "https://music.the816.com/history/",
  );
});

test("artist comparison state preserves public interval bounds and components", async ({
  page,
}) => {
  await page.goto("/artists/?from=2020-02&to=2020-04&artist=synthetic-eligible-artist&view=table");
  await expect(page.locator(".filter-panel__summary")).toContainText(
    "Showing 1 eligible interval from Feb 2020–Apr 2020, table first",
  );
  await expect(page.locator("#artist-interval-table")).toContainText("Jan 2020–Apr 2020");
  await expect(page.locator("#artist-interval-table")).toContainText("75%");
  await expect(page.locator("#artist-component-table tbody tr")).toHaveCount(4);
  await expect(page.locator("#artist-component-table tbody")).toContainText("Jan 2020");
  await expect(page.locator("link[rel='canonical']")).toHaveAttribute(
    "href",
    "https://music.the816.com/artists/?from=2020-02&artist=synthetic-eligible-artist&view=table",
  );
});

test("eligible artist detail is static, aggregate, and connects only reviewed editorial track text", async ({
  page,
}) => {
  await page.goto("/artists/synthetic-eligible-artist/?from=2020-02&view=components");
  await expect(page.locator("h1")).toContainText("Synthetic Eligible Artist");
  await expect(page.getByText("Reviewed featured-artist note")).toBeVisible();
  await expect(
    page.getByText("Wholly Manual Track Artist — Wholly Manual Selected Track"),
  ).toBeVisible();
  await expect(page.locator("#artist-period-table tbody tr")).toHaveCount(4);
  await expect(
    page.getByRole("link", { name: "Synthetic Eligible Artist · Jan 2020" }).first(),
  ).toHaveAttribute(
    "href",
    "/artists/?from=2020-01&to=2020-01&artist=synthetic-eligible-artist&view=table",
  );
  await expect(page.locator("body")).toContainText("not individual listens or an event log");
  await expect(page.locator("body")).not.toContainText("private-tail");
  await expect(page.locator("link[rel='canonical']")).toHaveAttribute(
    "href",
    "https://music.the816.com/artists/synthetic-eligible-artist/?from=2020-02&view=components",
  );
});

test("an ineligible artist slug has the same static not-found experience", async ({ page }) => {
  const response = await page.goto("/artists/private-tail/");
  expect(response?.status()).toBe(404);
  await expect(page.locator("h1")).toContainText("This part of the record is not public");
  await expect(page.locator("body")).not.toContainText("private-tail");
});

test("the shell reflows at 320 CSS pixels and honors reduced motion", async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 320 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/methodology/");

  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  await expect(
    page.getByRole("table", { name: "Public analytical definition register" }),
  ).toBeVisible();

  const animationDuration = await page
    .locator(".page-intro__rule span")
    .first()
    .evaluate((element) => getComputedStyle(element).animationDuration);
  expect(Number.parseFloat(animationDuration)).toBeLessThanOrEqual(0.001);
});

test("meaningful navigation and methodology remain when JavaScript is disabled", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:4321/history/");
  await expect(page.locator("h1")).toContainText("Where the evidence speaks");
  await expect(page.getByRole("link", { name: "Read the full methodology" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Spotify-only duration" })).toBeVisible();
  await context.close();
});

test("artist summaries, tables, and eligible detail remain when JavaScript is disabled", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:4321/artists/");
  await expect(
    page.getByRole("heading", { name: "Eligible artist intervals, peaks, and overlaps" }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: /Eligible aggregate artist intervals/u }),
  ).toBeVisible();
  await page.goto("http://127.0.0.1:4321/artists/synthetic-eligible-artist/");
  await expect(page.getByRole("table", { name: /Public period summaries/u })).toBeVisible();
  await expect(page.getByText("Reviewed featured-artist note")).toBeVisible();
  await context.close();
});
