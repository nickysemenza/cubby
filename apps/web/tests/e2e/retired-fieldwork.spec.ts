import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// Scanning, recount, sweep, and the location photo pass moved to the native
// app; their web routes are gone and answer with the ordinary not-found page.

test("retired fieldwork routes return not found", async ({ request }) => {
  for (const path of [
    "/scan",
    "/inventory/session",
    "/inventory/session?parent=LOC-4K7M",
    "/inventory/session?worklist=shelf-disagrees",
    "/locations/photo-pass",
    "/locations/photo-pass?parent=LOC-4K7M",
  ]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(404);
  }
});

test("pages no longer advertise an installable app", async ({ page }) => {
  await gotoAuthenticatedPage(page, "/settings");
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(0);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(0);
});
