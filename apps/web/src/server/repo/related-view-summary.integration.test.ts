import { expenseCreateInput, projectCreateInput } from "@cubby/schemas/project";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import {
  relatedBranchInput,
  relatedSummaryInput,
} from "@cubby/schemas/related-view";
import { vendorCreateInput } from "@cubby/schemas/vendor";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { productImage, projectImage } from "~/server/db/schema";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

import { insertAndReturn } from "./database-helpers";
import { createExpense, deleteExpenses } from "./expense";
import { createProject } from "./project";
import { createPurchase } from "./purchase";
import { loadRelatedBranch, loadRelatedSummary } from "./related-view";
import {
  createProductFixture as createProduct,
  makeProductInput,
} from "./repo.fixtures";
import { insertWithShortcode } from "./shortcode-utils";
import { createVendor } from "./vendor";

describe("expense-backed relationship summaries", () => {
  const ctx = withTestDb();
  const summary = (input: z.input<typeof relatedSummaryInput>) =>
    loadRelatedSummary(ctx.db, relatedSummaryInput.parse(input));

  it("groups all six curated scopes from live expense rows", async () => {
    const vendor = await createVendor(
      ctx.db,
      vendorCreateInput.parse({ name: "Summary Vendor" }),
      ctx.actor,
    );
    const purchase = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        vendorId: vendor.output.id,
        orderId: "SUMMARY-1",
        date: "2026-05-25",
        // This deliberately disagrees with the expense lines: it must never
        // participate in summary spend.
        statedTotal: 999,
      }),
      ctx.actor,
    );
    const secondPurchase = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        vendorId: vendor.output.id,
        orderId: "SUMMARY-2",
        date: "2026-05-27",
        statedTotal: 500,
      }),
      ctx.actor,
    );
    const root = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Summary root" }),
      ctx.actor,
    );
    const child = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "Summary child",
        parentProjectId: root.output.id,
      }),
      ctx.actor,
    );
    const productA = await createProduct(
      ctx.db,
      makeProductInput({ name: "Summary Product A" }),
      ctx.actor,
    );
    const productB = await createProduct(
      ctx.db,
      makeProductInput({ name: "Summary Product B" }),
      ctx.actor,
    );
    const thumbnail = await insertWithShortcode(ctx.db, "image", {
      key: "summary-product-image",
      filename: "summary-product.jpg",
      size: 1,
      contentType: "image/jpeg",
    });
    await insertAndReturn(ctx.db, productImage, {
      productId: productA.entityId,
      imageId: thumbnail.id,
    });
    const projectDocument = await insertWithShortcode(ctx.db, "image", {
      key: "summary-project-document",
      filename: "summary-project.pdf",
      size: 1,
      contentType: "application/pdf",
    });
    await insertAndReturn(ctx.db, projectImage, {
      projectId: root.entityId,
      imageId: projectDocument.id,
      sortOrder: -1,
    });
    const projectThumbnail = await insertWithShortcode(ctx.db, "image", {
      key: "summary-project-image",
      filename: "summary-project.jpg",
      size: 1,
      contentType: "image/jpeg",
    });
    await insertAndReturn(ctx.db, projectImage, {
      projectId: root.entityId,
      imageId: projectThumbnail.id,
    });
    const addExpense = async (data: {
      name: string;
      cost: number | null;
      projectId?: string | null;
      productId?: string | null;
      productQuantity?: number | null;
      purchaseId?: string | null;
      future?: boolean;
    }) =>
      createExpense(
        ctx.db,
        expenseCreateInput.parse({
          name: data.name,
          cost: data.cost,
          date: "2026-05-26",
          costType: "materials",
          trade: "other",
          projectId: data.projectId ?? null,
          productId: data.productId ?? null,
          productQuantity: data.productQuantity ?? null,
          purchaseId: data.purchaseId ?? null,
          future: data.future ?? false,
        }),
        ctx.actor,
      );

    await addExpense({
      name: "root acquired",
      cost: 10,
      projectId: root.output.id,
      productId: productA.id,
      productQuantity: 2,
      purchaseId: purchase.output.id,
    });
    await addExpense({
      name: "second purchase unpriced",
      cost: null,
      projectId: child.output.id,
      productId: productA.id,
      purchaseId: secondPurchase.output.id,
    });
    await addExpense({
      name: "second purchase acquired",
      cost: 2,
      projectId: root.output.id,
      productId: productB.id,
      productQuantity: 3,
      purchaseId: secondPurchase.output.id,
    });
    await addExpense({
      name: "service with no linked product",
      cost: 6,
      projectId: child.output.id,
      purchaseId: secondPurchase.output.id,
    });
    const deleted = await addExpense({
      name: "deleted summary line",
      cost: 100,
      projectId: root.output.id,
      productId: productA.id,
      productQuantity: 100,
      purchaseId: purchase.output.id,
    });
    await deleteExpenses(ctx.db, [deleted.output.id], ctx.actor);
    await addExpense({
      name: "child unknown quantity",
      cost: 5,
      projectId: child.output.id,
      productId: productA.id,
      purchaseId: purchase.output.id,
    });
    await addExpense({
      name: "child credit",
      cost: -3,
      projectId: child.output.id,
      productId: productB.id,
      purchaseId: purchase.output.id,
    });
    await addExpense({
      name: "unassigned planned",
      cost: 7,
      productId: productB.id,
      purchaseId: purchase.output.id,
      future: true,
    });
    await addExpense({
      name: "no purchase",
      cost: 4,
      projectId: root.output.id,
      productId: productA.id,
      productQuantity: 1,
    });

    const vendorProducts = await summary({
      relationKey: "vendor.products",
      sourceId: vendor.output.id,
    });
    expect(vendorProducts.totals).toMatchObject({
      expenseCount: 6,
      purchaseCount: 2,
      unpricedExpenseCount: 1,
      netSpend: 21,
      knownAcquiredUnits: 5,
      unknownAcquisitionQuantityCount: 1,
    });
    expect(
      vendorProducts.data.find((row) => row.target?.id === productA.id),
    ).toMatchObject({
      purchaseCount: 2,
      unpricedExpenseCount: 1,
      latestActivity: "2026-05-27",
      knownAcquiredUnits: 2,
      unknownAcquisitionQuantityCount: 1,
      target: {
        image: {
          id: thumbnail.id,
          url: getR2PublicUrl(thumbnail.key),
          filename: "summary-product.jpg",
          contentType: "image/jpeg",
        },
      },
    });

    const vendorProjects = await summary({
      relationKey: "vendor.projects",
      sourceId: vendor.output.id,
    });
    expect(vendorProjects.totals.netSpend).toBe(27);
    expect(vendorProjects.data.some((row) => row.target === null)).toBe(true);
    expect(
      vendorProjects.data.find((row) => row.target?.id === root.output.id),
    ).toMatchObject({
      target: {
        image: {
          id: projectThumbnail.id,
          url: getR2PublicUrl(projectThumbnail.key),
          filename: "summary-project.jpg",
          contentType: "image/jpeg",
        },
      },
    });

    const purchaseProjects = await summary({
      relationKey: "purchase.projects",
      sourceId: purchase.output.id,
    });
    expect(purchaseProjects.totals.netSpend).toBe(19);
    expect(
      purchaseProjects.data.find((row) => row.target === null)?.netSpend,
    ).toBe(7);

    const projectVendors = await summary({
      relationKey: "project.vendors",
      sourceId: root.output.id,
      includeSubProjects: true,
    });
    expect(projectVendors.totals).toMatchObject({
      netSpend: 24,
      unpricedExpenseCount: 1,
      purchaseCount: 2,
    });
    expect(projectVendors.data.some((row) => row.target === null)).toBe(true);

    const projectProducts = await summary({
      relationKey: "project.purchasedProducts",
      sourceId: root.output.id,
      includeSubProjects: true,
    });
    expect(projectProducts.totals.netSpend).toBe(18);
    expect(projectProducts.count).toBe(2);
    const rootOnlyProducts = await summary({
      relationKey: "project.purchasedProducts",
      sourceId: root.output.id,
    });
    expect(rootOnlyProducts.totals.netSpend).toBe(16);

    const productVendors = await summary({
      relationKey: "product.vendors",
      sourceId: productA.id,
    });
    expect(productVendors.totals.netSpend).toBe(19);
    expect(productVendors.data.some((row) => row.target === null)).toBe(true);

    const sortedAndPaged = await summary({
      relationKey: "vendor.products",
      sourceId: vendor.output.id,
      search: "Product",
      sort: { field: "netSpend", direction: "asc" },
      limit: 1,
    });
    expect(sortedAndPaged.count).toBe(2);
    expect(sortedAndPaged.totals.netSpend).toBe(21);
    expect(sortedAndPaged.nextOffset).toBe(1);
    expect(sortedAndPaged.data[0]?.target?.label).toBe("Summary Product B");
    const secondPage = await summary({
      relationKey: "vendor.products",
      sourceId: vendor.output.id,
      search: "Product",
      sort: { field: "netSpend", direction: "asc" },
      offset: 1,
      limit: 1,
    });
    expect(secondPage.data[0]?.target?.label).toBe("Summary Product A");
    expect(secondPage.nextOffset).toBeNull();
  });
});

/**
 * `SQL_RELATED_VIEWS["product.purchases"]` carries a `where`, and it is ANDed
 * into every consumer of the view — preview, branch, options, and the list
 * filter — so a Purchase can never appear in one and be absent from another.
 *
 * The predicate matters because a product-linked Expense reaches a Purchase in
 * BOTH directions: a sale, return, or disposal is a Purchase whose Expenses sum
 * negative. Without it the column filed 181 eBay-sale and disposal orders under
 * a product's "Purchases", disagreeing with the detail page's Purchases card.
 */
describe("product.purchases admits acquisitions only", () => {
  const ctx = withTestDb();

  it("omits the order that sold the product, and keeps the one that bought it", async () => {
    const vendor = await createVendor(
      ctx.db,
      vendorCreateInput.parse({ name: "Flip Channel" }),
      ctx.actor,
    );
    const bought = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        vendorId: vendor.output.id,
        orderId: "ACQUIRED-1",
        date: "2026-01-05",
      }),
      ctx.actor,
    );
    const sold = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        vendorId: vendor.output.id,
        orderId: "DISPOSED-1",
        date: "2026-05-01",
      }),
      ctx.actor,
    );
    const widget = await createProduct(
      ctx.db,
      makeProductInput({ name: "Flipped Widget" }),
      ctx.actor,
    );

    const line = async (
      name: string,
      cost: number,
      quantity: number,
      purchaseId: string,
    ) =>
      createExpense(
        ctx.db,
        expenseCreateInput.parse({
          name,
          cost,
          date: "2026-05-26",
          costType: "materials",
          trade: "other",
          productId: widget.id,
          productQuantity: quantity,
          purchaseId,
        }),
        ctx.actor,
      );

    await line("bought the widget", 100, 1, bought.output.id);
    await line("sold the widget", -60, -1, sold.output.id);

    const branch = await loadRelatedBranch(
      ctx.db,
      relatedBranchInput.parse({
        relationKey: "product.purchases",
        sourceId: widget.id,
      }),
    );
    const orderIds = branch.items.map((item) => item.label);
    expect(orderIds).toContain("ACQUIRED-1");
    expect(orderIds).not.toContain("DISPOSED-1");
    expect(branch.totalCount).toBe(1);

    // The transpose, from the same one-expression predicate: the disposal order
    // did not BUY the widget, so its Products column must not list it, while
    // the acquiring order's must. Before this, 385 purchases listed a product
    // they sold and 172 were pure disposals whose entire Products column was
    // items sold — each disagreeing with its own detail card.
    const productsOf = async (purchaseId: string) =>
      (
        await loadRelatedBranch(
          ctx.db,
          relatedBranchInput.parse({
            relationKey: "purchase.products",
            sourceId: purchaseId,
          }),
        )
      ).items.map((item) => item.label);

    expect(await productsOf(bought.output.id)).toContain("Flipped Widget");
    expect(await productsOf(sold.output.id)).not.toContain("Flipped Widget");
  });
});
