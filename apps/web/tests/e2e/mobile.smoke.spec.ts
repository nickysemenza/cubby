import { gotoAuthenticatedPage, waitForAppHydration } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test.describe("iPhone WebKit smoke", () => {
  test("prewarms and opens the More sheet on touch intent", async ({
    page,
  }) => {
    const more = page.getByRole("button", { name: "More options" });
    await gotoAuthenticatedPage(page, "/", more);
    await more.dispatchEvent("touchstart");
    await page.waitForTimeout(100);
    await more.click();
    await expect(page.getByRole("dialog", { name: "More" })).toBeVisible();
  });

  test("a preload error reloads once and preserves the destination URL", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      try {
        const key = "cubby:e2e-document-loads";
        sessionStorage.setItem(
          key,
          String(Number(sessionStorage.getItem(key) ?? "0") + 1),
        );
      } catch {
        // The initial opaque document can reject storage access.
      }
    });
    await page.goto("/locations/new#deploy-skew", {
      waitUntil: "domcontentloaded",
    });
    await waitForAppHydration(page);
    await page.evaluate(() =>
      sessionStorage.removeItem("cubby:preload-reload-at"),
    );
    const destination = page.url();
    const loadsBefore = await page.evaluate(() =>
      Number(sessionStorage.getItem("cubby:e2e-document-loads")),
    );

    const reloaded = page.waitForNavigation({ waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      setTimeout(() => {
        const event = new Event("vite:preloadError", { cancelable: true });
        Object.defineProperty(event, "payload", {
          value: new TypeError("Failed to fetch dynamically imported module"),
        });
        window.dispatchEvent(event);
      }, 0);
    });
    await reloaded;
    expect(page.url()).toBe(destination);
    expect(
      await page.evaluate(() =>
        Number(sessionStorage.getItem("cubby:e2e-document-loads")),
      ),
    ).toBe(loadsBefore + 1);
  });

  test("an intended document navigation wins over preload recovery", async ({
    page,
  }) => {
    await page.goto("/products", { waitUntil: "domcontentloaded" });
    await waitForAppHydration(page);
    await page.evaluate(() =>
      sessionStorage.removeItem("cubby:preload-reload-at"),
    );
    const navigated = page.waitForNavigation({ waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      const event = new Event("vite:preloadError", { cancelable: true });
      Object.defineProperty(event, "payload", {
        value: new TypeError("Load failed"),
      });
      window.dispatchEvent(event);
      window.location.assign("/recipes?deploy-skew-navigation=1");
    });
    await navigated;
    await expect(page).toHaveURL(/\/recipes\?deploy-skew-navigation=1$/);
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("cubby:preload-reload-at"),
      ),
    ).toBeNull();
  });

  test("offline fallback remains usable on iPhone", async ({ page }) => {
    await page.goto("/offline.html");
    await expect(
      page.getByRole("heading", { name: "You're offline" }),
    ).toBeVisible();
    const retry = page.getByRole("button", { name: "Try again" });
    await expect(retry).toBeVisible();
    expect((await retry.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  });
});
