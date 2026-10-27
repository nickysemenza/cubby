import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { taxonomyId } from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  expense as expenseTable,
  product as productTable,
  purchase as purchaseTable,
  vendor as vendorTable,
  financialTransaction as transactionTable,
} from "~/server/db/schema";
import { readExpenseById } from "~/server/domains/expense/repo/crud";
import { createInventoryEntry } from "~/server/domains/inventory/repo/crud";
import { readProductById } from "~/server/domains/product/repo/crud";
import { attachProductComponents } from "~/server/domains/product/repo/product-components";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createProductIdentityFixture,
  makeExpenseInput,
  makeProductInput,
  createRecipeFixture,
  makeRecipeInput,
  createLocationFixture,
  makeLocationInput,
} from "~/server/testing/repo.fixtures";

import { specialistResetPreview } from "./specialist-reset-preview";

describe("specialist reset previews", () => {
  const ctx = withTestDb();
  const product = (name: string, price: number | null = 99) =>
    createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name, price }),
      ctx.actor,
    );

  it("previews the current serving yield without retaining the removed override", async () => {
    const recipe = await createRecipeFixture(
      ctx.db,
      {
        ...makeRecipeInput({ name: "Synthetic reset yield" }),
        servings: 9,
        yield: { value: 4, unit: "servings" },
      },
      ctx.actor,
    );
    expect(
      await specialistResetPreview(
        ctx.db,
        "recipe",
        "servings",
        recipe.entityId,
      ),
    ).toEqual({
      kind: "live",
      decision: {
        outcome: { kind: "value", value: 4 },
        provenance: { kind: "computed" },
      },
    });
  });

  it("previews evidence policies from current sources while preserving each override", async () => {
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic reset policy supplier",
      orderEvidence: "online_account",
      itemizationExpectation: "not_expected",
    });
    const purchase = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-10-01",
      itemizationExpectation: "required",
    });
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic preview cash",
      identity: { kind: "cash" },
    });
    const transaction = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      amount: 12,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-10-01",
      purchaseId: purchase.output.id,
      itemizationExpectation: "not_expected",
    });
    expect(
      await specialistResetPreview(
        ctx.db,
        "vendor",
        "itemizationExpectation",
        vendor.entityId,
      ),
    ).toMatchObject({
      kind: "live",
      decision: {
        outcome: { kind: "value", value: "required" },
        provenance: { kind: "computed" },
      },
    });
    expect(
      await specialistResetPreview(
        ctx.db,
        "purchase",
        "itemizationExpectation",
        purchase.entityId,
      ),
    ).toMatchObject({
      kind: "live",
      decision: {
        outcome: { kind: "value", value: "not_expected" },
        provenance: {
          kind: "inherited",
          source: { entityId: vendor.output.id },
        },
      },
    });
    expect(
      await specialistResetPreview(
        ctx.db,
        "financialTransaction",
        "itemizationExpectation",
        transaction.entityId,
      ),
    ).toMatchObject({
      kind: "live",
      decision: { outcome: { kind: "value", value: "required" } },
    });
    const [storedVendor, storedPurchase, storedTransaction] = await Promise.all(
      [
        getDb(ctx.db)
          .select({ value: vendorTable.itemizationExpectation })
          .from(vendorTable)
          .where(eq(vendorTable.id, vendor.entityId)),
        getDb(ctx.db)
          .select({ value: purchaseTable.itemizationExpectation })
          .from(purchaseTable)
          .where(eq(purchaseTable.id, purchase.entityId)),
        getDb(ctx.db)
          .select({ value: transactionTable.itemizationExpectation })
          .from(transactionTable)
          .where(eq(transactionTable.id, transaction.entityId)),
      ],
    );
    expect(storedVendor).toEqual([{ value: "not_expected" }]);
    expect(storedPurchase).toEqual([{ value: "required" }]);
    expect(storedTransaction).toEqual([{ value: "not_expected" }]);
  });

  it("distinguishes blocked acquisition evidence from explicit household ownership on reset", async () => {
    const item = await product("Synthetic ownership reset item", null);
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic reset shelf" }),
      ctx.actor,
    );
    const entry = await createInventoryEntry(
      ctx.db,
      {
        productId: item.entityId,
        locationId: shelf.entityId,
        amount: { value: 1, unit: "each" },
        ownershipMode: "explicit",
        ownerLedgerPartyId: null,
      },
      ctx.actor,
    );
    expect(
      await specialistResetPreview(
        ctx.db,
        "inventory",
        "ownerLedgerPartyId",
        await resolveOrThrow(ctx.db, "inventory", entry.id),
      ),
    ).toEqual({
      kind: "live",
      decision: {
        outcome: { kind: "empty", reason: "blocked" },
        provenance: null,
      },
    });
  });

  it("clears only the local Expense project and spending category for their previews", async () => {
    const inherited = await createRepoEntity(ctx, "project", {
      name: "Synthetic inherited preview project",
    });
    const own = await createRepoEntity(ctx, "project", {
      name: "Synthetic local preview project",
    });
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic inherited preview category",
    });
    const ownCategory = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic own preview category",
    });
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic project preview supplier",
    });
    const purchase = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-10-01",
      defaultProjectId: inherited.output.id,
      spendingCategoryId: category.shortcode,
    });
    const expense = await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        purchaseId: purchase.output.id,
        projectId: own.output.id,
        spendingCategoryId: ownCategory.shortcode,
        cost: 12,
      }),
    );
    expect(
      await specialistResetPreview(
        ctx.db,
        "expense",
        "projectId",
        expense.entityId,
      ),
    ).toMatchObject({
      kind: "live",
      decision: {
        outcome: { kind: "value", value: inherited.output.id },
        provenance: {
          kind: "inherited",
          source: { entityId: purchase.output.id },
        },
      },
    });
    expect(
      await specialistResetPreview(
        ctx.db,
        "expense",
        "spendingCategoryId",
        expense.entityId,
      ),
    ).toMatchObject({
      kind: "live",
      decision: { outcome: { kind: "value", value: category.shortcode } },
    });
    expect(
      (await readExpenseById(ctx.db, expense.entityId)).fieldResolutions
        ?.projectId?.storedValue,
    ).toBe(own.output.id);
  });

  it("computes the live Expense price aggregate without changing the own price or ledger", async () => {
    const item = await product("Synthetic preview item");
    await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        productId: item.id,
        productQuantity: 4,
        cost: 20,
      }),
    );
    expect(
      await specialistResetPreview(ctx.db, "product", "price", item.entityId),
    ).toMatchObject({
      kind: "live",
      decision: {
        outcome: { kind: "value", value: 5 },
        provenance: { kind: "computed" },
      },
    });
    await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        productId: item.id,
        productQuantity: 2,
        cost: 16,
      }),
    );
    expect(
      await specialistResetPreview(ctx.db, "product", "price", item.entityId),
    ).toMatchObject({
      kind: "live",
      decision: {
        outcome: { kind: "value", value: 6 },
        provenance: { kind: "computed" },
      },
    });
    const unchanged = await readProductById(ctx.db, item.entityId);
    expect(unchanged.price).toBe(99);
    const retainedExpenses = await getDb(ctx.db)
      .select({ cost: expenseTable.cost })
      .from(expenseTable)
      .where(eq(expenseTable.productId, item.entityId));
    expect(retainedExpenses).toHaveLength(2);
    expect(retainedExpenses.map((row) => row.cost)).toEqual(
      expect.arrayContaining([16, 20]),
    );
  });

  it("prices a component through its acquired kit without inventing a single inherited source", async () => {
    const kit = await product("Synthetic preview kit", null);
    const first = await product("Synthetic preview component");
    const second = await product("Synthetic preview paired component", null);
    await attachProductComponents(
      ctx.db,
      kit.entityId,
      [
        { productId: first.entityId, quantity: 1 },
        { productId: second.entityId, quantity: 2 },
      ],
      ctx.actor,
    );
    await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        productId: kit.id,
        productQuantity: 1,
        cost: 30,
      }),
    );
    expect(
      await specialistResetPreview(ctx.db, "product", "price", first.entityId),
    ).toEqual({
      kind: "live",
      decision: {
        outcome: { kind: "value", value: 10 },
        provenance: { kind: "computed" },
      },
    });
  });

  it("returns successful unset without acquisitions and refuses service or unassigned resets", async () => {
    const item = await product("Synthetic preview unacquired item");
    expect(
      await specialistResetPreview(ctx.db, "product", "price", item.entityId),
    ).toEqual({
      kind: "live",
      decision: {
        outcome: { kind: "empty", reason: "unset" },
        provenance: { kind: "computed" },
      },
    });
    const unassigned = await product("Synthetic preview inherited item", null);
    expect(
      await specialistResetPreview(
        ctx.db,
        "product",
        "price",
        unassigned.entityId,
      ),
    ).toBeNull();
    // Retained intent may outlive a classification change; it never grants edit authority.
    await getDb(ctx.db)
      .update(productTable)
      .set({ categoryId: taxonomyId("services") })
      .where(eq(productTable.id, item.entityId));
    expect(
      await specialistResetPreview(ctx.db, "product", "price", item.entityId),
    ).toBeNull();
    expect(
      (await readProductById(ctx.db, item.entityId)).fieldResolutions?.price,
    ).toMatchObject({
      storedValue: 99,
      assignmentAllowed: false,
      canReset: false,
    });
  });

  it("uses Purchase then Project defaults after clearing only a principal's local trade", async () => {
    const project = await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic preview project",
      defaultTrade: "building",
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic preview supplier",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-10-01",
      defaultProjectId: project.id,
      defaultTrade: "plumbing",
    });
    const line = await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        purchaseId: purchase.shortcode,
        projectId: null,
        trade: "electrical",
        lineKind: "principal",
      }),
    );
    expect(
      await specialistResetPreview(ctx.db, "expense", "trade", line.entityId),
    ).toMatchObject({
      kind: "live",
      decision: {
        outcome: { kind: "value", value: "plumbing" },
        provenance: {
          kind: "inherited",
          source: { entityKind: "purchase", entityId: purchase.shortcode },
        },
      },
    });
    await getDb(ctx.db)
      .update(purchaseTable)
      .set({ defaultTrade: null })
      .where(eq(purchaseTable.id, purchase.id));
    expect(
      await specialistResetPreview(ctx.db, "expense", "trade", line.entityId),
    ).toMatchObject({
      kind: "live",
      decision: {
        outcome: { kind: "value", value: "building" },
        provenance: {
          kind: "inherited",
          source: { entityKind: "project", entityId: project.shortcode },
        },
      },
    });
    const unchanged = await readExpenseById(ctx.db, line.entityId);
    expect(unchanged.fieldResolutions?.trade?.storedValue).toBe("electrical");
    expect(unchanged.fieldResolutions?.projectId?.storedValue).toBeNull();
  });

  it("names the deciding Project ancestor without changing principal assignments or ledger evidence", async () => {
    const ancestor = await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic deciding trade project",
      defaultTrade: "building",
    });
    const parent = await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic inheriting trade project",
      parentProjectId: ancestor.id,
      defaultTrade: null,
    });
    const linked = await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic linked trade project",
      parentProjectId: parent.id,
      defaultTrade: null,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic ancestor supplier",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-10-01",
      defaultProjectId: linked.id,
      defaultTrade: null,
    });
    const principal = await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        purchaseId: purchase.shortcode,
        projectId: null,
        trade: "electrical",
        lineKind: "principal",
        cost: 42,
      }),
    );
    const before = await getDb(ctx.db)
      .select()
      .from(expenseTable)
      .where(eq(expenseTable.id, principal.entityId));
    expect(
      await specialistResetPreview(
        ctx.db,
        "expense",
        "trade",
        principal.entityId,
      ),
    ).toEqual({
      kind: "live",
      decision: {
        outcome: { kind: "value", value: "building" },
        provenance: {
          kind: "inherited",
          source: {
            entityKind: "project",
            entityId: ancestor.shortcode,
            name: ancestor.name,
          },
        },
      },
    });
    expect(
      await getDb(ctx.db)
        .select()
        .from(expenseTable)
        .where(eq(expenseTable.id, principal.entityId)),
    ).toEqual(before);
    const unchanged = await readExpenseById(ctx.db, principal.entityId);
    expect(unchanged.fieldResolutions?.trade).toMatchObject({
      storedValue: "electrical",
      canReset: true,
    });
    expect(unchanged.fieldResolutions?.projectId?.storedValue).toBeNull();
    expect(unchanged.cost).toBe(42);
    expect(unchanged.purchaseId).toBe(purchase.shortcode);
  });

  it("refuses to reset a principal's only trade and ignores unsupported fields", async () => {
    const principal = await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        projectId: null,
        purchaseId: null,
        productId: null,
        trade: "electrical",
        lineKind: "principal",
      }),
    );
    expect(
      await specialistResetPreview(
        ctx.db,
        "expense",
        "trade",
        principal.entityId,
      ),
    ).toBeNull();
    expect(
      (await readExpenseById(ctx.db, principal.entityId)).fieldResolutions
        ?.trade?.canReset,
    ).toBe(false);
    expect(
      await specialistResetPreview(
        ctx.db,
        "product",
        "brandId",
        "unused-unsupported-id",
      ),
    ).toBeNull();
  });
});
