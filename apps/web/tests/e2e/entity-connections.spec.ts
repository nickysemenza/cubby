import { z } from "zod";

import {
  publishEntityConnection,
  readEntityConnections,
} from "~/server/domains/connection/repo/entity-connections";

import {
  createEntityFixture,
  createEvidenceHarnessContext,
} from "./fixtures/core";
import {
  gotoAuthenticatedPage,
  readExpense,
  uniqueName,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

// Failure modes: a list connection silently applies on discovery; review writes
// another row; accepting from one endpoint leaves a second pending review.
test("RTable connection review binds the chosen Expense and settles both endpoints", async ({
  page,
}, testInfo) => {
  const { db } = await createEvidenceHarnessContext(page);
  const name = uniqueName(testInfo, "Connection drill");
  const item = await createEntityFixture(page, "product", { name });
  const line = await createEntityFixture(page, "expense", {
    name,
    cost: 24,
    productId: null,
    trade: "electrical",
  });
  await publishEntityConnection(db, {
    relation: "product-expense",
    source: { entityKind: "product", entityId: item.id },
    target: { entityKind: "expense", entityId: line.id },
    label: "This Expense acquired this Product",
    evidence: {
      reasons: ["Synthetic itemized receipt names this exact variant"],
      contradictions: [],
      unknowns: [],
    },
  });
  const saved = () =>
    readExpense(page, line.id, z.object({ productId: z.string().nullable() }));
  expect((await saved()).productId).toBeNull();
  await gotoAuthenticatedPage(page, `/products?q=${encodeURIComponent(name)}`);
  const row = page.getByRole("row").filter({ hasText: name });
  await row
    .getByRole("button", { name: "1 pending suggestion", exact: true })
    .click();
  const review = page.getByRole("region", {
    name: "Pending suggestions",
    exact: true,
  });
  expect((await saved()).productId).toBeNull();
  await expect(review).toContainText("This Expense acquired this Product");
  await review.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect.poll(async () => (await saved()).productId).toBe(item.id);
  await gotoAuthenticatedPage(page, `/expenses/${line.id}#relationships`);
  const settled = page.getByRole("region", {
    name: "Pending suggestions",
    exact: true,
  });
  await expect(settled).toContainText("No pending suggestions.");
  await expect(
    settled.getByRole("button", { name: "Confirm", exact: true }),
  ).toHaveCount(0);
});

test("Purchase title column exposes inverse acquisition review", async ({
  page,
}, testInfo) => {
  const { db } = await createEvidenceHarnessContext(page);
  const name = uniqueName(testInfo, "Connection order");
  const item = await createEntityFixture(page, "product", {
    name: `${name} drill`,
  });
  const vendor = await createEntityFixture(page, "vendor", {
    name: `${name} shop`,
  });
  const order = await createEntityFixture(page, "purchase", {
    vendorId: vendor.id,
    orderId: name,
    date: "2026-09-01",
  });
  const source = { entityKind: "product" as const, entityId: item.id };
  await publishEntityConnection(db, {
    relation: "product-purchase",
    source,
    target: { entityKind: "purchase", entityId: order.id },
    label: "Review retrospective acquisition",
    evidence: {
      reasons: ["Synthetic saved order evidence"],
      contradictions: [],
      unknowns: ["Amount and quantity remain unknown"],
    },
  });
  await gotoAuthenticatedPage(page, `/purchases?q=${encodeURIComponent(name)}`);
  const row = page.getByRole("row").filter({ hasText: name });
  await row
    .getByRole("button", { name: "1 pending suggestion", exact: true })
    .click();
  const review = page.getByRole("region", {
    name: "Pending suggestions",
    exact: true,
  });
  await expect(review).toContainText("Review retrospective acquisition");
  await expect.poll(() => readEntityConnections(db, source)).not.toEqual([]);
  await review.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect.poll(() => readEntityConnections(db, source)).toEqual([]);
  await gotoAuthenticatedPage(page, `/products/${item.id}#relationships`);
  const settled = page.getByRole("region", {
    name: "Pending suggestions",
    exact: true,
  });
  await expect(settled).toContainText("No pending suggestions.");
  await expect(
    settled.getByRole("button", { name: "Confirm", exact: true }),
  ).toHaveCount(0);
});
