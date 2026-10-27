import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { z } from "zod";
import { assessmentReviewBatchOut } from "@cubby/schemas/assessment";
import { and, eq } from "drizzle-orm";

import { getDb, notDeleted } from "~/server/db/helpers";
import { entityLink, expense } from "~/server/db/schema";
import {
  publishEntityConnection,
  readEntityConnections,
} from "~/server/domains/connection/repo/entity-connections";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  createFixtureGraph,
  createEvidenceHarnessContext,
} from "./fixtures/core";
import {
  gotoAuthenticatedPage,
  readExpense,
  uniqueName,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { dispatchesOperation, operationResult } from "./support/dispatch-wire";

// List discovery is advisory. Confirmation must commit the chosen relation
// without changing its money; SQL owns retirement at both endpoints and replay.
test("RTable connection review commits the chosen Expense", async ({
  page,
}, testInfo) => {
  const { db } = await createEvidenceHarnessContext(page);
  const name = uniqueName(testInfo, "Connection drill");
  const { item, line } = await createFixtureGraph(page, async (create) => {
    const item = await create("product", { name });
    const line = await create("expense", {
      name,
      cost: 24,
      productId: null,
      trade: "electrical",
    });
    return { item, line };
  });
  const proposal = await publishEntityConnection(db, {
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
    readExpense(
      page,
      line.id,
      z.object({
        fields: entityFieldEnvelopeSchemas.expense.detail.shape.fields.pick({
          productId: true,
        }),
        cost: z.number(),
      }),
    );
  expect(fieldValueOf((await saved()).fields.productId)).toBeNull();
  await gotoAuthenticatedPage(
    page,
    `/products?searchQuery=${encodeURIComponent(name)}`,
  );
  const row = page.getByRole("row").filter({ hasText: name });
  await row
    .getByRole("button", { name: "1 pending suggestion", exact: true })
    .click();
  const review = page.getByRole("region", {
    name: "Pending suggestions",
    exact: true,
  });
  expect(fieldValueOf((await saved()).fields.productId)).toBeNull();
  await expect(review).toContainText("This Expense acquired this Product");
  const [application] = await Promise.all([
    page.waitForResponse((response) =>
      dispatchesOperation(response.request(), "assessment.reviewBatch"),
    ),
    review.getByRole("button", { name: "Confirm", exact: true }).click(),
  ]);
  expect(
    await operationResult(
      application,
      "assessment.reviewBatch",
      assessmentReviewBatchOut,
    ),
  ).toMatchObject([
    { ok: true, assessmentId: proposal.review.assessmentId, applied: true },
  ]);
  await expect
    .poll(async () => {
      const expense = await saved();
      return {
        productId: fieldValueOf(expense.fields.productId),
        cost: expense.cost,
      };
    })
    .toMatchObject({ productId: item.id, cost: 24 });
});

test("Purchase title column exposes inverse acquisition review", async ({
  page,
}, testInfo) => {
  const { db } = await createEvidenceHarnessContext(page);
  const name = uniqueName(testInfo, "Connection order");
  const { item, order } = await createFixtureGraph(page, async (create) => {
    const item = await create("product", { name: `${name} drill` });
    const vendor = await create("vendor", { name: `${name} shop` });
    const order = await create("purchase", {
      vendorId: vendor.id,
      orderId: name,
      date: "2026-09-01",
    });
    return { item, order };
  });
  const purchaseId = await resolveOrThrow(db, "purchase", order.id);
  const productId = await resolveOrThrow(db, "product", item.id);
  const acquisition = () =>
    getDb(db).query.entityLink.findFirst({
      where: and(
        eq(entityLink.kind, "purchaseProduct"),
        eq(entityLink.fromEntityId, purchaseId),
        eq(entityLink.toEntityId, productId),
        notDeleted(entityLink),
      ),
    });
  expect(await acquisition()).toBeUndefined();
  const source = { entityKind: "product" as const, entityId: item.id };
  const proposal = await publishEntityConnection(db, {
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
  await gotoAuthenticatedPage(
    page,
    `/purchases?searchQuery=${encodeURIComponent(name)}`,
  );
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
  const [application] = await Promise.all([
    page.waitForResponse((response) =>
      dispatchesOperation(response.request(), "assessment.reviewBatch"),
    ),
    review.getByRole("button", { name: "Confirm", exact: true }).click(),
  ]);
  expect(
    await operationResult(
      application,
      "assessment.reviewBatch",
      assessmentReviewBatchOut,
    ),
  ).toMatchObject([
    { ok: true, assessmentId: proposal.review.assessmentId, applied: true },
  ]);
  await expect.poll(() => readEntityConnections(db, source)).toEqual([]);
  expect(await acquisition()).toMatchObject({ acquisitionConfirmed: true });
  expect(
    await getDb(db).query.expense.findMany({
      where: and(eq(expense.purchaseId, purchaseId), notDeleted(expense)),
    }),
  ).toHaveLength(0);
});
