/**
 * The browser tab title, end to end.
 *
 * The regression this pins: titles used to reach the tab two different ways —
 * a router-rendered `<title>` element and an imperative `document.title` write
 * in `useDocumentTitle` — and the imperative one restored a SNAPSHOT on unmount.
 * React runs an unmounting component's effect cleanup after it has committed the
 * incoming route's `<title>`, so navigating a detail page → a list page wrote the
 * stale snapshot ("Cubby") over a correct "Products | cubby", and nothing put it
 * back. The tab stayed wrong until a hard refresh, which is why the bug looked
 * intermittent: only tabs navigated into from a detail page were affected.
 *
 * Assert on titles rather than on the mechanism, so a future change of mechanism
 * is free as long as the tab stays right.
 */

import { expect, test } from "@playwright/test";
import { createProduct } from "./e2e-helpers";

/** Pull the canonical code out of a detail URL like /products/PRD-4K7M. */
const codeFromUrl = (url: string): string => {
  const match = url.match(/\/products\/([A-Z]{3}-[A-Z0-9]{4})/);
  if (!match?.[1]) throw new Error(`no shortcode in URL: ${url}`);
  return match[1];
};

test.describe("tab titles", () => {
  test("survive a detail → list navigation", async ({ page }) => {
    const name = `E2E Title Product ${Date.now()}`;
    await createProduct(page, name);
    const code = codeFromUrl(page.url());

    // The shortcode comes from route params, so it lands without waiting on the
    // product query; the name follows once that resolves.
    await expect(page).toHaveTitle(new RegExp(`^${code}( · |$)`), {
      timeout: 15000,
    });
    await expect(page).toHaveTitle(`${code} · ${name} | cubby`, {
      timeout: 15000,
    });

    // Client-side navigation, not page.goto — a full load always got this right,
    // which is exactly why the bug survived so long.
    await page.getByRole("link", { name: "Products", exact: true }).click();
    await expect(page).toHaveURL(/\/products$/, { timeout: 15000 });
    await expect(page).toHaveTitle("Products | cubby", { timeout: 15000 });

    // The clobber landed one commit LATE, so a title that is correct on arrival
    // could still be overwritten a tick later. Re-assert after settling.
    await page.waitForTimeout(1000);
    await expect(page).toHaveTitle("Products | cubby");
  });

  test("summarize the active filters and sort of a list page", async ({
    page,
  }) => {
    await page.goto("/products?name=packout&sort=-price");
    await expect(page).toHaveTitle("Products: packout ↓price | cubby", {
      timeout: 15000,
    });

    // Server-rendered too, so the tab is right before hydration.
    const html = await page.request
      .get("/products?name=packout&sort=-price")
      .then((response) => response.text());
    expect(html).toContain("<title>Products: packout ↓price | cubby</title>");

    // An unfiltered list collapses back to the bare entity name.
    await page.goto("/products");
    await expect(page).toHaveTitle("Products | cubby", { timeout: 15000 });
  });
});
