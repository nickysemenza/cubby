import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("server error references open as a bounded sheet on a phone", async ({
  page,
}) => {
  const more = page.getByRole("button", { name: "More options" });
  await gotoAuthenticatedPage(page, "/", more);
  await page.route("**/_serverFn/**", async (route) => {
    if (route.request().headers()["x-cubby-operation"] !== "entity.list") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 500,
      headers: {
        "content-type": "text/plain",
        "x-request-id": "diagnostic-test-request",
      },
      body: "Internal Server Error",
    });
  });
  await more.click();
  await page
    .getByRole("dialog", { name: "More" })
    .getByRole("link", { name: /^Locations(?: [\d,]+ records)?$/ })
    .click();
  await expect(
    page.getByText("Server request failed (HTTP 500)", { exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Details", exact: true })
    .first()
    .click();
  // ResponsiveDialog renders a Sheet below 768px.
  const sheet = page.getByRole("dialog", { name: "Technical details" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("entity.list / dispatch");
  await expect(
    sheet.getByRole("button", { name: "Copy details" }),
  ).toBeVisible();
  const bounds = await sheet.boundingBox();
  const viewportWidth = page.viewportSize()?.width ?? 0;
  expect(bounds).not.toBeNull();
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(
    viewportWidth,
  );
});
