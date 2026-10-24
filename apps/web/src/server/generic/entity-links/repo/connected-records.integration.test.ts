import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { product } from "~/server/db/schema";
import { createExpense } from "~/server/domains/expense/repo/crud";
import { createPlanting } from "~/server/domains/garden/repo/garden";
import { attachPurchaseProducts } from "~/server/domains/purchase/repo/purchase-products";
import { createVendor } from "~/server/domains/vendor/repo/vendor";
import {
  createPlantFixture,
  createProductIdentityFixture,
  makeExpenseInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import {
  getConnectedRecords,
  getConnectedRecordsPreview,
} from "./connected-records";
import { loadRelatedBranch } from "./related-view";

describe("complete connected record tables", () => {
  const ctx = withTestDb();

  it("connects split card settlements to itemized and explicit products and vendors in both directions", async () => {
    const firstVendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic tools",
    });
    const secondVendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic supplies",
    });
    const first = await createRepoEntity(ctx, "purchase", {
      vendorId: firstVendor.output.id,
    });
    const second = await createRepoEntity(ctx, "purchase", {
      vendorId: secondVendor.output.id,
    });
    const explicit = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic drill" }),
      ctx.actor,
    );
    const itemized = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic fasteners" }),
      ctx.actor,
    );
    await attachPurchaseProducts(
      ctx.db,
      first.entityId,
      [explicit.entityId],
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Synthetic line",
        purchaseId: second.output.id,
        productId: itemized.id,
      }),
      ctx.actor,
    );
    // Two evidence paths to one product must not duplicate its connected row.
    await attachPurchaseProducts(
      ctx.db,
      second.entityId,
      [itemized.entityId],
      ctx.actor,
    );
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic card",
      identity: { kind: "credit_card", issuer: null, network: "visa" },
    });
    const transaction = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-10-01",
      amount: 30,
      merchant: "Synthetic tools",
      purchaseId: null,
      allocations: [
        { purchaseId: first.output.id, amount: 10 },
        { purchaseId: second.output.id, amount: 20 },
      ],
    });
    const unrelated = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-10-01",
      amount: 30,
      merchant: "Synthetic tools",
      purchaseId: null,
    });
    const source = {
      entityKind: "financialTransaction" as const,
      entityId: transaction.output.id,
    };
    const products = await getConnectedRecords(ctx.db, {
      source,
      viewKey: "entity:product",
    });
    expect(products.items.map((item) => item.target.entityId).sort()).toEqual(
      [explicit.id, itemized.id].sort(),
    );
    expect(
      products.items.find((item) => item.target.entityId === explicit.id)
        ?.paths,
    ).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({
            entityKind: "purchase",
            entityId: first.output.id,
          }),
        ]),
      ]),
    );
    expect(
      products.items
        .find((item) => item.target.entityId === itemized.id)
        ?.paths.map((path) => path.map((node) => node.entityKind)),
    ).toEqual(
      expect.arrayContaining([
        ["financialTransaction", "purchase", "expense", "product"],
        ["financialTransaction", "purchase", "product"],
      ]),
    );
    const context = await getConnectedRecordsPreview(ctx.db, {
      source,
      scope: "context",
    });
    expect(
      context.views.find((view) => view.targetEntity === "product")?.totalCount,
    ).toBe(2);
    expect(
      context.views.find((view) => view.targetEntity === "vendor")?.totalCount,
    ).toBe(2);
    const vendors = await getConnectedRecords(ctx.db, {
      source,
      viewKey: "entity:vendor",
    });
    expect(vendors.items.map((item) => item.target.entityId).sort()).toEqual(
      [firstVendor.output.id, secondVendor.output.id].sort(),
    );
    for (const record of [
      { entityKind: "product" as const, entityId: explicit.id },
      { entityKind: "product" as const, entityId: itemized.id },
      { entityKind: "vendor" as const, entityId: firstVendor.output.id },
      { entityKind: "vendor" as const, entityId: secondVendor.output.id },
    ]) {
      const reverse = await getConnectedRecords(ctx.db, {
        source: record,
        viewKey: "entity:financialTransaction",
      });
      expect(reverse.items.map((item) => item.target.entityId)).toEqual([
        transaction.output.id,
      ]);
    }
    const unlinked = await getConnectedRecordsPreview(ctx.db, {
      source: {
        entityKind: "financialTransaction",
        entityId: unrelated.output.id,
      },
    });
    expect(
      unlinked.views
        .filter(
          (view) =>
            view.targetEntity === "vendor" || view.targetEntity === "product",
        )
        .every((view) => view.totalCount === 0),
    ).toBe(true);
  });

  it("queries sources without a soft-delete column", async () => {
    const page = await getConnectedRecords(ctx.db, {
      source: { entityKind: "run", entityId: "RUN-EXAMPLE" },
      viewKey: "products",
    });
    expect(page.totalCount).toBe(0);
  });

  it("follows a planting task's inherited project assignment", async () => {
    const plant = await createPlantFixture(
      ctx.db,
      { name: "Inherited crop" },
      ctx.actor,
    );
    const project = await createRepoEntity(ctx, "project", {
      name: "Inherited project",
    });
    const parent = await createRepoEntity(ctx, "task", {
      name: "Parent work",
      trade: "other",
      projectId: project.output.id,
    });
    const child = await createRepoEntity(ctx, "task", {
      name: "Child work",
      trade: "other",
      parentTaskId: parent.output.id,
    });
    await createPlanting(
      ctx.db,
      { plantId: plant.id, taskId: child.output.id, status: "planned" },
      ctx.actor,
    );

    const result = await getConnectedRecords(ctx.db, {
      source: { entityKind: "plant", entityId: plant.id },
      viewKey: "projects",
    });
    expect(
      result.items.find((item) => item.target.entityId === project.output.id)
        ?.paths,
    ).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({ entityKind: "planting" }),
          expect.objectContaining({
            entityKind: "task",
            entityId: child.output.id,
          }),
        ]),
      ]),
    );
  });

  it("pages distinct Plant purchases and preserves every actual record path", async () => {
    const plant = await createPlantFixture(
      ctx.db,
      { name: "Example crop" },
      ctx.actor,
    );
    const seed = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Example seeds", growsPlantId: plant.id }),
      ctx.actor,
    );
    const starter = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Example starter", growsPlantId: plant.id }),
      ctx.actor,
    );
    const vendor = await createVendor(
      ctx.db,
      {
        defaultSpendingCategoryId: null,
        spendingProfile: "unspecified",
        aliases: [],
        name: "Example supplier",
        website: null,
        orderUrlTemplate: null,
        itemizationExpectation: null,
        orderEvidence: null,
        orderEmailSenders: [],
        browserDomains: [],
        returnWindowDays: null,
        agentHints: {
          ordersListUrl: null,
          pagination: null,
          orderLinkPattern: null,
          notes: [],
        },
        notes: null,
      },
      ctx.actor,
    );
    const purchase = async (orderId: string) =>
      createRepoEntity(ctx, "purchase", {
        vendorId: vendor.output.id,
        orderId,
        displayLabel: orderId,
        date: "2026-09-08",
        statedTotal: 10,
        notes: null,
      });
    const first = await purchase("example-order-one");
    const second = await purchase("example-order-two");
    await attachPurchaseProducts(
      ctx.db,
      first.entityId,
      [seed.entityId],
      ctx.actor,
    );
    await attachPurchaseProducts(
      ctx.db,
      second.entityId,
      [starter.entityId],
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Example seed line",
        productId: seed.id,
        purchaseId: first.output.id,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Example second seed line",
        productId: seed.id,
        purchaseId: first.output.id,
      }),
      ctx.actor,
    );

    const source = { entityKind: "plant" as const, entityId: plant.id };
    const page1 = await getConnectedRecords(ctx.db, {
      source,
      viewKey: "purchases",
      limit: 1,
      offset: 0,
    });
    const page2 = await getConnectedRecords(ctx.db, {
      source,
      viewKey: "purchases",
      limit: 1,
      offset: 1,
    });
    expect(page1.totalCount).toBe(2);
    expect(page2.totalCount).toBe(2);
    expect(
      new Set(
        [...page1.items, ...page2.items].map((item) => item.target.entityId),
      ),
    ).toEqual(new Set([first.output.id, second.output.id]));
    const firstRecord = [...page1.items, ...page2.items].find(
      (item) => item.target.entityId === first.output.id,
    );
    expect(firstRecord?.shortestHops).toBe(2);
    expect(
      firstRecord?.paths.map((path) => path.map((node) => node.entityKind)),
    ).toEqual(
      expect.arrayContaining([
        ["plant", "product", "purchase"],
        ["plant", "product", "expense", "purchase"],
      ]),
    );
    expect(firstRecord?.paths.filter((path) => path.length === 4)).toHaveLength(
      2,
    );

    const vendorProducts = await loadRelatedBranch(ctx.db, {
      relationKey: "vendor.products",
      sourceId: vendor.output.id,
      offset: 0,
      limit: 25,
    });
    expect(vendorProducts.totalCount).toBe(1);
    expect(vendorProducts.items.map((item) => item.id)).toEqual([seed.id]);

    // The detail page reads every view at once: totals stay complete while
    // rows stop at the preview limit, in manifest order.
    const { result: preview, queryCount } = await countTestDbQueries(() =>
      getConnectedRecordsPreview(ctx.db, {
        source,
        limit: 1,
      }),
    );
    expect(queryCount).toBe(1);
    const purchases = preview.views.find(
      (view) => view.targetEntity === "purchase",
    );
    expect(purchases?.totalCount).toBe(2);
    expect(purchases?.items).toEqual(page1.items);

    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, starter.entityId));
    const afterDelete = await getConnectedRecords(ctx.db, {
      source,
      viewKey: "purchases",
    });
    expect(afterDelete.totalCount).toBe(1);
    expect(afterDelete.items[0]?.target.entityId).toBe(first.output.id);
  });
});
