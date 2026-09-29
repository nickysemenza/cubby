import type { Page } from "@playwright/test";
import { z } from "zod";

import { expect, test } from "./e2e-test";

const created = z.object({ item: z.object({ id: z.string() }) });

// Seeds through the signed-in HTTP API so the spec exercises the same write
// paths the app uses and needs no direct database access.
type Payload = NonNullable<
  NonNullable<Parameters<Page["request"]["post"]>[1]>["data"]
>;

async function post(page: Page, baseURL: string, path: string, data: Payload) {
  const response = await page.request.post(`/api/v1/${path}`, {
    headers: { Origin: baseURL },
    data,
  });
  expect(response.status(), await response.text()).toBe(201);
  return created.parse(await response.json()).item.id;
}

test("filters transactions by how well their purchase is itemized", async ({
  page,
  baseURL,
}) => {
  const origin = baseURL!;
  const tag = `Itemization ${Date.now()}`;
  const accountId = await post(page, origin, "financial-accounts", {
    name: `${tag} card`,
    identity: { kind: "credit_card", issuer: null, network: "visa" },
  });
  const vendorId = await post(page, origin, "vendors", { name: `${tag} shop` });
  const productId = await post(page, origin, "products", {
    name: `${tag} good`,
    manufacturer: "E2E fixture",
  });
  const purchase = (orderId: string) =>
    post(page, origin, "purchases", {
      vendorId,
      orderId: `${tag} ${orderId}`,
      date: "2026-09-10",
    });
  const line = (purchaseId: string, cost: number, itemized: boolean) =>
    post(page, origin, "expenses", {
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
    post(page, origin, "financial-transactions", {
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
