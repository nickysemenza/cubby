import { seedProductPrerequisite } from "./e2e-fixtures";
import { waitForAppHydration } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

const hydrationWarning =
  /hydration|hydrating|did not match|server rendered html/i;

test.describe("product detail SSR", () => {
  test("renders authenticated detail before JavaScript and hydrates without refetching", async ({
    baseURL,
    browser,
    page,
  }, testInfo) => {
    const productName = `E2E SSR Product ${testInfo.workerIndex}-${Date.now()}`;
    const product = await seedProductPrerequisite(page, { name: productName });
    if (!baseURL) throw new Error("Playwright baseURL is required");
    const detailUrl = new URL(`/products/${product.id}`, baseURL).href;
    const storageState = await page.context().storageState();

    // JavaScript is deliberately disabled: a visible heading here can only
    // have come from the initial personalized HTML, not route hydration.
    const serverOnlyContext = await browser.newContext({
      javaScriptEnabled: false,
      storageState,
    });
    try {
      const serverOnlyPage = await serverOnlyContext.newPage();
      const response = await serverOnlyPage.goto(detailUrl);
      expect(response?.headers()["cache-control"]).toBe(
        "private, no-cache, must-revalidate",
      );
      await expect(
        serverOnlyPage.getByRole("heading", { level: 1, name: productName }),
      ).toBeVisible({ timeout: 15000 });

      // Preserve the existing authenticated not-found response during SSR.
      await serverOnlyPage.goto(new URL("/products/PRD-ZZZZ", detailUrl).href);
      await expect(
        serverOnlyPage.getByRole("heading", {
          level: 1,
          name: "Product not found",
        }),
      ).toBeVisible({ timeout: 15000 });
    } finally {
      await serverOnlyContext.close();
    }

    // Use a fresh browser context so IndexedDB cannot satisfy the product
    // query. The SSR-dehydrated cache must prevent a duplicate browser Start
    // request while React hydrates the initial document.
    const hydratedContext = await browser.newContext({ storageState });
    try {
      const hydratedPage = await hydratedContext.newPage();
      const productRequests: string[] = [];
      const hydrationMessages: string[] = [];

      hydratedPage.on("request", (request) => {
        if (request.url().includes("product.getByShortcode")) {
          productRequests.push(request.url());
        }
      });
      hydratedPage.on("console", (message) => {
        if (
          (message.type() === "warning" || message.type() === "error") &&
          hydrationWarning.test(message.text())
        ) {
          hydrationMessages.push(message.text());
        }
      });

      await hydratedPage.goto(detailUrl);
      await expect(
        hydratedPage.getByRole("heading", { level: 1, name: productName }),
      ).toBeVisible({ timeout: 15000 });
      await waitForAppHydration(hydratedPage);

      expect(productRequests).toEqual([]);
      expect(hydrationMessages).toEqual([]);
    } finally {
      await hydratedContext.close();
    }
  });
});
