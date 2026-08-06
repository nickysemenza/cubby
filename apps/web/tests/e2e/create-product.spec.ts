import { test } from "@playwright/test";
import { createProduct } from "./e2e-helpers";

test.describe("Create Product", () => {
  test("can create a new product and view detail", async ({ page }) => {
    await createProduct(page, `E2E Product ${Date.now()}`, {
      manufacturer: "E2E Manufacturer",
    });
  });
});
