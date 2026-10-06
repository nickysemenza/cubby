import {
  BROWSER_SOURCE_ORDERS,
  createConvergenceHarness,
} from "./import-order-convergence.helpers";
import { gotoAuthenticatedPage, uniqueName } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

for (const order of BROWSER_SOURCE_ORDERS) {
  test(`Gmail, retailer, own photos and statement converge: ${order.join(" → ")}`, async ({
    page,
    baseURL,
  }, testInfo) => {
    test.setTimeout(120_000);
    await gotoAuthenticatedPage(page, "/statement-rows");
    const token = uniqueName(testInfo, "order")
      .replaceAll(/[^a-zA-Z0-9-]/g, "-")
      .toLowerCase();
    const harness = await createConvergenceHarness(page, baseURL!, token);
    if (order.join(",") === "csv,photo,retailer,gmail") {
      // The Problems overview samples twelve findings. A Run must retain its
      // reviewed action after earlier receipt arrivals fill that sample.
      for (let index = 0; index < 13; index++) {
        const earlier = await createConvergenceHarness(
          page,
          baseURL!,
          `${token}-earlier-${index}`,
        );
        await earlier.sources.retailer();
        expect(await earlier.openFindingCount()).toBeGreaterThanOrEqual(1);
      }
    }
    for (const source of order)
      await test.step(`${source} source arrival`, () =>
        harness.sources[source]());
    const result = await harness.settle();
    expect(await harness.projection()).toEqual({
      purchases: 1,
      products: 1,
      expenses: 1,
      categorizedExpenses: 1,
      productLines: 1,
      settledPurchases: 1,
      spend: 4250,
      transactions: 1,
      settlement: 4250,
      inventory: 1,
      ownedQuantity: 1,
      observations: 1,
      matchedObservations: 1,
      mail: 1,
      linkedMail: 1,
    });
    await gotoAuthenticatedPage(page, `/purchases/${result.purchaseCode}`);
    await expect(
      page.getByText(harness.orderId, { exact: true }).first(),
    ).toBeVisible();
    if (!result.productCode) throw new Error("No reviewed Product identity");
    await gotoAuthenticatedPage(
      page,
      `/products/${result.productCode}`,
      page.getByRole("heading", { name: harness.productName, exact: true }),
    );
    await expect(
      page
        .locator("#images")
        .getByRole("img", { name: `${token}-shirt.png`, exact: true }),
    ).toHaveCount(1);
    await expect(
      page
        .locator("#labels")
        .getByRole("img", { name: `${token}-label.png`, exact: true }),
    ).toHaveCount(1);
    testInfo.annotations.push({
      type: "exercised-boundaries",
      description:
        "Gmail MIME+persist+classifier seam; retailer prepare/commit; photo HTTP stage/PUT/finalize+processing claim/completion supplied model response+browser approval; CSV browser shared writer+source-arrival booking review; targeted receipt aggregate replacement Problems approval",
    });
  });
}
