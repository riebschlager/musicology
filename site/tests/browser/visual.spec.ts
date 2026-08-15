import { expect, test } from "@playwright/test";

const shellWidths = [320, 768, 1_440] as const;

test.describe("editorial shell visual baselines", () => {
  for (const width of shellWidths) {
    test(`long-view shell at ${width} CSS pixels`, async ({ browserName, page }, testInfo) => {
      test.skip(
        browserName !== "chromium" || testInfo.project.name !== "chromium-desktop",
        "Visual baselines use the pinned desktop Chromium project only",
      );
      await page.setViewportSize({ height: 900, width });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      await expect(page).toHaveScreenshot(`long-view-shell-${width}.png`, {
        fullPage: true,
      });
    });
  }

  for (const width of shellWidths) {
    test(`overlapping artist-era state at ${width} CSS pixels`, async ({
      browserName,
      page,
    }, testInfo) => {
      test.skip(
        browserName !== "chromium" || testInfo.project.name !== "chromium-desktop",
        "Visual baselines use the pinned desktop Chromium project only",
      );
      await page.setViewportSize({ height: 900, width });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/artists/");
      await expect(page.locator(".artist-timeline__bar.is-overlap")).toHaveCount(2);
      await expect(page.locator(".artist-findings")).toContainText(
        "only one or two approved evidence windows",
      );
      await expect(page).toHaveScreenshot(`artist-era-overlap-${width}.png`, {
        fullPage: true,
      });
    });
  }
});
