import { seedInventoryPrerequisites } from "./e2e-fixtures";
import {
  SHORTCODE,
  gotoAuthenticatedPage,
  reloadAuthenticatedPage,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("recount is current-pass scoped, resumable, and completes with a summary", async ({
  page,
}) => {
  const suffix = Date.now();
  const locationName = `Recount bin ${suffix}`;
  const firstProduct = `Recount wrench ${suffix}`;
  const secondProduct = `Recount clamp ${suffix}`;

  const { location } = await seedInventoryPrerequisites(page, {
    locationName,
    products: [
      { name: firstProduct, quantity: 1, unit: "each" },
      { name: secondProduct, quantity: 1, unit: "each" },
    ],
  });
  // The public id is also the session's `parent` search param — no uuid ever
  // reaches a URL, query string included.
  const locationCode = location.id;
  expect(locationCode).toMatch(new RegExp(`^LOC-${SHORTCODE}$`));

  // Regression: the workbench resolves the global Unknown bin after the
  // session's rows are already interactive. Its arrival used to re-key the
  // session inventory query, flip the workbench back to its spinner, and
  // unmount the review pane, closing a "Change" sheet opened in that window.
  // Hold that response until the sheet is open so the window is always hit.
  let releaseUnknown = () => {};
  const unknownHeld = new Promise<void>((resolve) => {
    releaseUnknown = resolve;
  });
  let unknownRequested = false;
  await page.route("**/_serverFn/**", async (route) => {
    const request = route.request();
    const operation = request.headers()["x-cubby-operation"] ?? "";
    if (`${request.url()} ${operation}`.includes("ensureGlobalUnknown")) {
      unknownRequested = true;
      await unknownHeld;
    }
    await route.fallback();
  });

  const addButton = page.getByRole("button", { name: /Add something here/ });
  await gotoAuthenticatedPage(
    page,
    `/inventory/session?parent=${locationCode}`,
    addButton,
  );
  await expect(page.getByRole("combobox", { name: "manual add" })).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Decrease quantity" }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: `Change ${firstProduct}` }).click();
  const decrease = page.getByRole("button", { name: "Decrease quantity" });
  await expect(decrease).toBeVisible();
  expect(unknownRequested).toBe(true);
  releaseUnknown();
  await page.unrouteAll({ behavior: "wait" });
  // "Move to Unknown" enables once Unknown has arrived; the sheet it lives in
  // must still be the one opened above.
  await expect(
    page.getByRole("button", { name: "Move to Unknown" }),
  ).toBeEnabled();
  await expect(decrease).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(
    page.getByRole("main").getByText(firstProduct, { exact: true }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Finish — rest are present (2)" })
    .click();

  await expect(
    page.getByRole("heading", {
      name: `${locationName} recount complete`,
    }),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    page.getByText("1 location saved · 2 items confirmed"),
  ).toBeVisible();

  const completedHeading = page.getByRole("heading", {
    name: `${locationName} recount complete`,
  });
  await reloadAuthenticatedPage(page, completedHeading);

  await page
    .getByRole("button", { name: `Recount ${locationName} again` })
    .click();
  await expect(
    page.getByRole("main").getByText(firstProduct, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Finish — rest are present (2)" }),
  ).toBeVisible();
});
