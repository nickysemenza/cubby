import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
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

    const sheet = page.getByRole("dialog", { name: "More" });
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByRole("link", { name: "Projects", exact: true }),
    ).toBeVisible();
  });

  test("rapid client navigation never enters the View Transitions API", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => {
      pageErrors.push(`${error.name}: ${error.message}`);
    });
    await page.addInitScript(() => {
      document.documentElement.dataset.cubbyViewTransitionCalls = "0";
      Object.defineProperty(document, "startViewTransition", {
        configurable: true,
        value: () => {
          const root = document.documentElement;
          root.dataset.cubbyViewTransitionCalls = String(
            Number(root.dataset.cubbyViewTransitionCalls ?? "0") + 1,
          );
          throw new DOMException(
            "Old view transition aborted by new view transition.",
            "AbortError",
          );
        },
      });
    });

    const bottomNav = page.getByRole("navigation", {
      name: "Main navigation",
    });
    await gotoAuthenticatedPage(page, "/", bottomNav);
    for (const label of [
      "Inventory",
      "Scan",
      "Today",
      "Search",
      "Inventory",
      "Scan",
      "Today",
      "Search",
    ]) {
      await bottomNav.getByRole("link", { name: label, exact: true }).click();
    }

    await expect(page).toHaveURL(/\/search$/);
    await expect(page.locator("body")).not.toContainText(
      "Something went wrong",
    );
    expect(
      await page.evaluate(() =>
        Number(
          document.documentElement.dataset.cubbyViewTransitionCalls ?? "0",
        ),
      ),
    ).toBe(0);
    expect(
      pageErrors.filter((message) =>
        message.includes("Old view transition aborted by new view transition."),
      ),
    ).toEqual([]);
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
        // The initial opaque about:blank document can reject storage access.
      }
    });

    await page.goto("/locations/new#deploy-skew", {
      waitUntil: "networkidle",
    });
    await page.evaluate(() =>
      sessionStorage.removeItem("cubby:preload-reload-at"),
    );
    const destination = page.url();
    const loadsBefore = await page.evaluate(() =>
      Number(sessionStorage.getItem("cubby:e2e-document-loads")),
    );

    const reloaded = page.waitForNavigation({ waitUntil: "networkidle" });
    await page.evaluate(() => {
      setTimeout(() => {
        const event = new Event("vite:preloadError", { cancelable: true });
        Object.defineProperty(event, "payload", {
          value: new TypeError(
            "Failed to fetch dynamically imported module: /assets/old.js",
          ),
        });
        window.dispatchEvent(event);
      }, 0);
    });
    await reloaded;

    expect(page.url()).toBe(destination);
    await expect(page.getByRole("textbox", { name: "Name" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(
      "Something went wrong",
    );
    expect(
      await page.evaluate(() =>
        Number(sessionStorage.getItem("cubby:e2e-document-loads")),
      ),
    ).toBe(loadsBefore + 1);
  });

  test("an intended document navigation wins over preload recovery", async ({
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
        // The initial opaque about:blank document can reject storage access.
      }
    });

    await page.goto("/products", { waitUntil: "networkidle" });
    await page.evaluate(() =>
      sessionStorage.removeItem("cubby:preload-reload-at"),
    );
    const loadsBefore = await page.evaluate(() =>
      Number(sessionStorage.getItem("cubby:e2e-document-loads")),
    );

    const navigated = page.waitForNavigation({ waitUntil: "networkidle" });
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
        Number(sessionStorage.getItem("cubby:e2e-document-loads")),
      ),
    ).toBe(loadsBefore + 1);
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("cubby:preload-reload-at"),
      ),
    ).toBeNull();
  });

  test("keeps the authenticated shell inside representative viewport boundaries", async ({
    page,
  }) => {
    for (const { path, viewport, mobile } of [
      {
        path: "/products",
        viewport: { width: 320, height: 568 },
        mobile: true,
      },
      { path: "/recipes", viewport: { width: 390, height: 844 }, mobile: true },
      { path: "/scan", viewport: { width: 430, height: 932 }, mobile: true },
      {
        path: "/products",
        viewport: { width: 844, height: 390 },
        mobile: false,
      },
      {
        path: "/products",
        viewport: { width: 768, height: 900 },
        mobile: false,
      },
      {
        path: "/products",
        viewport: { width: 1440, height: 900 },
        mobile: false,
      },
    ]) {
      await page.setViewportSize(viewport);
      const navigation = page.getByRole("navigation", {
        name: "Main navigation",
      });
      await gotoAuthenticatedPage(page, path, mobile ? navigation : undefined);
      await expectViewportBounded(page);
    }
  });

  test("offline fallback remains usable on iPhone", async ({ page }) => {
    await page.goto("/offline.html");
    await expect(
      page.getByRole("heading", { name: "You're offline" }),
    ).toBeVisible();
    const retry = page.getByRole("button", { name: "Try again" });
    await expect(retry).toBeVisible();
    const box = await retry.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  });
});
