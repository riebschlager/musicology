import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const routes = [
  "/",
  "/history/",
  "/artists/",
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
  await expect(page.getByText("Current state:")).toContainText("year grain, table first");
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
    page.getByRole("status").filter({ hasText: "Unsupported link options" }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("private-tail");
  await expect(page.locator("link[rel='canonical']")).toHaveAttribute(
    "href",
    "https://music.the816.com/explore/",
  );
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
  await expect(page.getByText("Spotify-only duration", { exact: true })).toBeVisible();
  await context.close();
});
