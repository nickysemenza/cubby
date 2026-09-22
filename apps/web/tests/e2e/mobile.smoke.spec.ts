import { gotoAuthenticatedPage } from "./e2e-helpers";
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
    await gotoAuthenticatedPage(page, "/locations#deploy-skew");
    await page.evaluate(() =>
      sessionStorage.removeItem("cubby:preload-reload-at"),
    );
    const destination = page.url();
    const loadsBefore = await page.evaluate(() =>
      Number(sessionStorage.getItem("cubby:e2e-document-loads")),
    );

    // A reload keeps the URL, so wait for the new document itself.
    const reloaded = page.waitForEvent("domcontentloaded");
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
    await gotoAuthenticatedPage(page, "/products");
    await page.evaluate(() =>
      sessionStorage.removeItem("cubby:preload-reload-at"),
    );
    await page.evaluate(() => {
      const event = new Event("vite:preloadError", { cancelable: true });
      Object.defineProperty(event, "payload", {
        value: new TypeError("Load failed"),
      });
      window.dispatchEvent(event);
      window.location.assign("/recipes?deploy-skew-navigation=1");
    });
    await page.waitForURL(/\/recipes\?deploy-skew-navigation=1$/, {
      waitUntil: "domcontentloaded",
    });
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("cubby:preload-reload-at"),
      ),
    ).toBeNull();
  });
});
