import {
  BROWSER_SOURCE_ORDERS,
  createConvergenceHarness,
} from "./import-order-convergence.helpers";
import { eq, and } from "drizzle-orm";
import * as schema from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { createEvidenceHarnessContext } from "./fixtures-core";
import { sha256Hex } from "../../tooling/convergence-harness";
import { uniqueName } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

for (const order of BROWSER_SOURCE_ORDERS) {
  test(`Gmail, retailer, own photos and statement converge: ${order.join(" → ")}`, async ({
    page,
    baseURL,
  }, testInfo) => {
    test.setTimeout(120_000);
    const token = uniqueName(testInfo, "order")
      .replaceAll(/[^a-zA-Z0-9-]/g, "-")
      .toLowerCase();
    const harness = await createConvergenceHarness(page, baseURL!, token);
    if (order.join(",") === "csv,photo,retailer,gmail") {
      // The Problems overview samples twelve findings. A Run must retain its
      // reviewed action after earlier receipt arrivals fill that sample.
      const earlier = await createConvergenceHarness(
        page,
        baseURL!,
        `${token}-earlier`,
      );
      await earlier.sources.retailer();
      const { db } = await createEvidenceHarnessContext(page);
      const database = getDb(db);
      const purchase = await database.query.purchase.findFirst({
        where: eq(schema.purchase.orderId, earlier.orderId),
      });
      if (!purchase) throw new Error("Background import created no Purchase");
      const finding = await database.query.runFinding.findFirst({
        where: and(
          eq(schema.runFinding.entityId, purchase.id),
          eq(schema.runFinding.status, "open"),
        ),
      });
      if (!finding)
        throw new Error("Background import created no open finding");
      // Only the sample's population matters; the foreground imports own the
      // writer coverage. Seed additional valid findings from the real writer.
      await database.insert(schema.runFinding).values(
        Array.from({ length: 12 }, (_, index) => ({
          runId: finding.runId,
          ledgerPartyId: finding.ledgerPartyId,
          entityId: finding.entityId,
          entityKind: finding.entityKind,
          kind: finding.kind,
          summary: finding.summary,
          proposedFix: finding.proposedFix,
          evidenceFingerprint: sha256Hex(`${token}-background-${index}`),
        })),
      );
      expect(await earlier.openFindingCount()).toBeGreaterThanOrEqual(13);
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
    const purchaseLink = page
      .locator("#order-mail")
      .getByRole("article")
      .filter({ hasText: harness.orderId })
      .getByRole("link", { name: harness.orderId, exact: true });
    await expect(purchaseLink).toHaveAttribute(
      "href",
      `/purchases/${result.purchaseCode}`,
    );
    const documentOrigin = await page.evaluate(() => performance.timeOrigin);
    await purchaseLink.click();
    await expect(page).toHaveURL(
      new RegExp(`/purchases/${result.purchaseCode}$`),
    );
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(
      documentOrigin,
    );
    await expect(
      page.getByText(harness.orderId, { exact: true }).first(),
    ).toBeVisible();
    if (!result.productCode) throw new Error("No reviewed Product identity");
    const productLink = page
      .getByRole("link", { name: harness.productName, exact: true })
      .and(page.locator(`a[href="/products/${result.productCode}"]`))
      .first();
    await expect(productLink).toHaveAttribute(
      "href",
      `/products/${result.productCode}`,
    );
    await productLink.click();
    await expect(page).toHaveURL(
      new RegExp(`/products/${result.productCode}$`),
    );
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(
      documentOrigin,
    );
    await expect(
      page.getByRole("heading", { name: harness.productName, exact: true }),
    ).toBeVisible();
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
