import { createFixtureGraph } from "./fixtures/core";
import { expect, test } from "./support/e2e-test";

test("filters transactions by how well their purchase is itemized", async ({
  page,
}) => {
  const tag = `Itemization ${Date.now()}`;
  await createFixtureGraph(page, async (create) => {
    const { id: accountId } = await create("financialAccount", {
      name: `${tag} card`,
      identity: { kind: "credit_card", issuer: null, network: "visa" },
    });
    const { id: vendorId } = await create("vendor", { name: `${tag} shop` });
    const { id: productId } = await create("product", {
      name: `${tag} good`,
      brandId: vendorId,
    });
    const purchase = async (orderId: string) =>
      (
        await create("purchase", {
          vendorId,
          orderId: `${tag} ${orderId}`,
          date: "2026-09-10",
        })
      ).id;
    const line = (purchaseId: string, cost: number, itemized: boolean) =>
      create("expense", {
        lineKind: "principal",
        name: `${tag} line ${cost}`,
        cost,
        date: "2026-09-10",
        costType: "materials",
        trade: "other",
        purchaseId,
        ...(itemized
          ? { productId, productQuantity: 1 }
          : { lineBasis: "allocation" }),
      });
    const charge = (merchant: string, purchaseId: string, amount: number) =>
      create("financialTransaction", {
        accountId,
        kind: "purchase",
        status: "posted",
        postedDate: "2026-09-12",
        amount,
        merchant: `${tag} ${merchant}`,
        allocations: [{ purchaseId, amount }],
      });

    const lump = await purchase("lump");
    await line(lump, 80, false);
    await charge("lump charge", lump, 80);

    const solo = await purchase("solo");
    await line(solo, 25, true);
    await charge("solo charge", solo, 25);

    const installments = await purchase("installments");
    await line(installments, 60, true);
    await line(installments, 40, true);
    await charge("first installment", installments, 60);
    await charge("second installment", installments, 40);
  });

  const search = `q=${encodeURIComponent(tag)}`;
  await page.goto(`/financial-transactions?${search}`);
  await expect(page.getByRole("row", { name: /solo charge/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /lump charge/ })).toBeVisible();

  await page.goto(`/financial-transactions?${search}&itemization=shared`);
  await expect(
    page.getByRole("row", { name: /first installment/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: /second installment/ }),
  ).toBeVisible();
  await expect(page.getByRole("row", { name: /solo charge/ })).toHaveCount(0);
  await expect(page.getByRole("row", { name: /lump charge/ })).toHaveCount(0);

  await page.goto(`/financial-transactions?${search}&itemization=lump`);
  await expect(page.getByRole("row", { name: /lump charge/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /solo charge/ })).toHaveCount(0);
});
