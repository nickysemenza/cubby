import { test } from "@playwright/test";
import { createProduct } from "./e2e-helpers";

test.describe("Create Product", () => {
  test("can create a new product and view detail", async ({ page }) => {
    // createProduct fills name + manufacturer, submits, and asserts the
    // id-bearing detail URL, the <h1> name heading, and Basic Information.
    await createProduct(page, `E2E Product ${Date.now()}`, {
      manufacturer: "E2E Manufacturer",
    });
  });
});
