import { test } from "@playwright/test";
import { createLocation } from "./e2e-helpers";

test.describe("Create Location", () => {
  test("can create a new location and view detail", async ({ page }) => {
    await createLocation(page, `E2E Location ${Date.now()}`);
  });
});
