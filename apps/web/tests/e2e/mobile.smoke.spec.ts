import { expect, test } from "@playwright/test";

test.describe("iPhone WebKit smoke", () => {
  test("prewarms and opens the More sheet on touch intent", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    const more = page.getByRole("button", { name: "More options" });

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
      const trackedWindow = window as Window & {
        __cubbyViewTransitionCalls?: number;
      };
      trackedWindow.__cubbyViewTransitionCalls = 0;
      Object.defineProperty(document, "startViewTransition", {
        configurable: true,
        value: () => {
          trackedWindow.__cubbyViewTransitionCalls =
            (trackedWindow.__cubbyViewTransitionCalls ?? 0) + 1;
          throw new DOMException(
            "Old view transition aborted by new view transition.",
            "AbortError",
          );
        },
      });
    });

    await page.goto("/", { waitUntil: "networkidle" });
    const bottomNav = page.getByRole("navigation", {
      name: "Main navigation",
    });
    for (const label of [
      "Inventory",
      "Recipes",
      "Search",
      "Scan",
      "Shopping",
      "Recipes",
      "Inventory",
      "Search",
    ]) {
      await bottomNav.getByRole("link", { name: label, exact: true }).click();
    }

    await expect(page).toHaveURL(/\/search$/);
    await expect(page.locator("body")).not.toContainText(
      "Something went wrong",
    );
    expect(
      await page.evaluate(
        () =>
          (window as Window & { __cubbyViewTransitionCalls?: number })
            .__cubbyViewTransitionCalls ?? 0,
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
    await expect(
      page.getByRole("heading", { name: "New location" }),
    ).toBeVisible();
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

  test("navigates inventory, recipes, and forms with usable touch targets", async ({
    page,
  }) => {
    for (const path of [
      "/inventory/session",
      "/recipes",
      "/recipes/new",
      "/products/new",
    ]) {
      // Wait through TanStack Start hydration before starting the next direct
      // navigation; WebKit can otherwise race its same-URL hydration replace.
      await page.goto(path, { waitUntil: "networkidle" });
      await expect(page.locator("body")).not.toContainText(
        "Internal Server Error",
      );
    }

    const targets = page.locator(
      '[data-slot="button"]:visible, [data-slot="input"]:visible, [data-slot="tabs-trigger"]:visible, [role="option"]:visible, [role="menuitem"]:visible',
    );
    for (let index = 0; index < (await targets.count()); index += 1) {
      const box = await targets.nth(index).boundingBox();
      if (!box) continue;
      expect
        .soft(box.width, `target ${index} width`)
        .toBeGreaterThanOrEqual(44);
      expect
        .soft(box.height, `target ${index} height`)
        .toBeGreaterThanOrEqual(44);
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
