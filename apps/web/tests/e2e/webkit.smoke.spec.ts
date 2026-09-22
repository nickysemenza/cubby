import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// Engine-specific: preload recovery exists for Safari deploy skew, where a
// failed dynamic import surfaces as "Load failed" and the reload races
// WebKit's own document navigation. Phone layout belongs in `mobile.*`.
test.describe("WebKit smoke", () => {
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
