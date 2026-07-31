/**
 * The public-id URL contract, end to end.
 *
 * Before the cutover none of this was covered: `/$shortcode` had no e2e test at
 * all, and every detail URL was a uuid. These assertions are the guarantee that
 * a physical QR label — including one printed with a pre-cutover single-letter
 * code — still lands somewhere useful.
 */

import { expect, test } from "@playwright/test";
import { createLocation, createProduct } from "./e2e-helpers";

/** Pull the canonical code out of a detail URL like /products/PRD-4K7M. */
const codeFromUrl = (url: string): string => {
  const match = url.match(/\/(?:products|locations)\/([A-Z]{3}-[A-Z0-9]{4})/);
  if (!match?.[1]) throw new Error(`no shortcode in URL: ${url}`);
  return match[1];
};

/** `PRD-4K7M` -> `P-4K7M`: the spelling on labels printed before the cutover. */
const toLegacy = (code: string): string =>
  `${code[0]}-${code.slice(code.indexOf("-") + 1)}`;

test.describe("shortcode URLs", () => {
  test("a location scan lands on the in-place scan view, canonical and legacy", async ({
    page,
  }) => {
    const name = `E2E Scan Location ${Date.now()}`;
    await createLocation(page, name);
    const code = codeFromUrl(page.url());

    // The compact route renders the phone-first scan landing IN PLACE — a
    // scanned bin is a physical entry point, not a cue to open the desktop
    // detail page. So the URL must still be /<code>, not /locations/<code>.
    await page.goto(`/${code}`);
    await expect(page).toHaveURL(new RegExp(`/${code}$`));
    await expect(page.getByText("Add item here")).toBeVisible({
      timeout: 15000,
    });

    // A label printed before the cutover carries L-XXXX. Same destination.
    await page.goto(`/${toLegacy(code)}`);
    await expect(page.getByText("Add item here")).toBeVisible({
      timeout: 15000,
    });
  });

  test("a product scan redirects to the canonical detail URL, never a uuid", async ({
    page,
  }) => {
    const name = `E2E Scan Product ${Date.now()}`;
    await createProduct(page, name);
    const code = codeFromUrl(page.url());

    await page.goto(`/${code}`);
    await expect(page).toHaveURL(new RegExp(`/products/${code}$`), {
      timeout: 15000,
    });
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

    // The legacy code must resolve to the CANONICAL url — the pre-cutover route
    // redirected these to a uuid, which is exactly what this asserts is gone.
    await page.goto(`/${toLegacy(code)}`);
    await expect(page).toHaveURL(new RegExp(`/products/${code}$`), {
      timeout: 15000,
    });
  });

  test("a detail URL is addressable directly by shortcode", async ({
    page,
  }) => {
    const name = `E2E Direct Product ${Date.now()}`;
    await createProduct(page, name);
    const code = codeFromUrl(page.url());

    await page.goto(`/products/${code}`);
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible({
      timeout: 15000,
    });
  });

  test("an unknown or malformed code shows the not-found state", async ({
    page,
  }) => {
    // Malformed: 0/O/I/L are outside the shortcode alphabet.
    await page.goto("/PRD-0OIL");
    await expect(page.getByText("Nothing found for that code")).toBeVisible({
      timeout: 15000,
    });

    // Well-formed but unowned.
    await page.goto("/PRD-2222");
    await expect(
      page.getByText(/Nothing found|not found/i).first(),
    ).toBeVisible({ timeout: 15000 });
  });
});
