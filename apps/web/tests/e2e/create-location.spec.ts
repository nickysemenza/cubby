import { test } from "@playwright/test";
import { createLocation } from "./e2e-helpers";

test.describe("Create Location", () => {
  test("can create a new location and view detail", async ({ page }) => {
    // createLocation submits the form and asserts the id-bearing detail URL +
    // that the name renders on the detail page.
    await createLocation(page, `E2E Location ${Date.now()}`);
  });
});
