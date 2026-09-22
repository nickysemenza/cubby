import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// Safari preload-error recovery is engine-specific and lives in
// `webkit.smoke.spec.ts`.
test.describe("Phone smoke", () => {
  test("prewarms and opens the More sheet on touch intent", async ({
    page,
  }) => {
    const more = page.getByRole("button", { name: "More options" });
    await gotoAuthenticatedPage(page, "/", more);
    await more.dispatchEvent("touchstart");
    await page.waitForTimeout(100);
    await more.click();
    await expect(page.getByRole("dialog", { name: "More" })).toBeVisible();
  });
});
