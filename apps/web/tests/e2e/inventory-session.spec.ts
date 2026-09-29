import {
  seedInventoryPrerequisites,
  seedLocationPrerequisite,
} from "./e2e-fixtures";
import { seedLedgerProduct } from "./inventory-flow-fixtures";
import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";
import {
  SHORTCODE,
  gotoAuthenticatedPage,
  reloadAuthenticatedPage,
  uniqueName,
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
  await page.route(`**${BROWSER_OPERATION_PATH}`, async (route) => {
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

test("variance recount queues exactly the locations holding disagreeing products", async ({
  page,
}, testInfo) => {
  const disagreeingBin = uniqueName(testInfo, "Variance bin");
  const otherDisagreeingBin = uniqueName(testInfo, "Variance shelf");
  const agreeingBin = uniqueName(testInfo, "Agreeing bin");
  const [disagreeing, otherDisagreeing, agreeing] = await Promise.all([
    seedLocationPrerequisite(page, disagreeingBin),
    seedLocationPrerequisite(page, otherDisagreeingBin),
    seedLocationPrerequisite(page, agreeingBin),
  ]);
  const driftedProduct = uniqueName(testInfo, "Drifted wrench");
  // Bought three, one on the shelf: the shelf disagrees with the ledger.
  await seedLedgerProduct(page, {
    name: driftedProduct,
    bought: 3,
    stocked: { locationId: disagreeing.id, quantity: 1 },
  });
  await seedLedgerProduct(page, {
    name: uniqueName(testInfo, "Drifted clamp"),
    bought: 2,
    stocked: { locationId: otherDisagreeing.id, quantity: 1 },
  });
  // Bought one, one on the shelf: agrees, so its bin is not a stop.
  await seedLedgerProduct(page, {
    name: uniqueName(testInfo, "Settled level"),
    bought: 1,
    stocked: { locationId: agreeing.id, quantity: 1 },
  });

  const binButton = (name: string) =>
    page.getByRole("button", { name: new RegExp(name) });
  await gotoAuthenticatedPage(
    page,
    "/inventory/session?worklist=shelf-disagrees",
    binButton(disagreeingBin),
  );
  await expect(binButton(otherDisagreeingBin)).toBeVisible();
  await expect(binButton(agreeingBin)).toHaveCount(0);

  // Full bins, the existing workbench: opening a stop shows its whole contents
  // and Finish commits the recount for that bin only.
  await binButton(disagreeingBin).click();
  await expect(
    page.getByRole("main").getByText(driftedProduct, { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Finish — rest are present (1)" })
    .click();
  await expect(page.getByText("Bin recount saved.")).toBeVisible({
    timeout: 15000,
  });
});

test("the shelf-disagrees view offers a recount of its worklist", async ({
  page,
}) => {
  await gotoAuthenticatedPage(
    page,
    "/products",
    page.getByRole("button", { name: "Actions" }),
  );
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: /Saved views/ }).click();
  await page.getByRole("menuitem", { name: /Recount these/ }).click();
  await expect(page).toHaveURL(/\/inventory\/session\?worklist=shelf-disagrees/);
});
