import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { fromAny } from "@total-typescript/shoehorn";
import { sql } from "drizzle-orm";
import { createEntity } from "tooling/factories/create";
import { createRepoIdentity } from "tooling/factories/repo";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { setFieldsFixture } from "~/server/ai/fields/fields.fixtures";
import { insertFieldsFixture as insertWithShortcode } from "~/server/ai/fields/fields.fixtures";
import { unwrapDb } from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import { effectiveExpenseSpendingCategorySql } from "~/server/domains/expense/repo/expense-category-resolution";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import {
  applySpendingClassificationReview,
  applyReviewedSpendingClassificationPolicy,
  previewSpendingClassificationReview,
} from "./spending-classification-review";

// Database boundary regressions: preview must not write, and a changed amount
// or policy between preview/apply must refuse before any category assignment.
describe("reviewed spending classification", () => {
  const ctx = withTestDb();
  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );

  // Reassignment can change historical allocations without changing an Expense;
  // even an unbooked Product must participate in the stale-review fingerprint.
  it("reviews Product taxonomy reassignment without overwriting Expense intent", async () => {
    const oldSpend = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture furnishings",
    });
    const toolsSpend = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture tools",
    });
    const oldCategory = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture storage",
      spendingCategoryMode: "mapped",
      spendingCategoryId: oldSpend.id,
    });
    const parent = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture tools",
      spendingCategoryMode: "mapped",
      spendingCategoryId: toolsSpend.id,
    });
    const target = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture tool storage",
      parentId: parent.id,
    });
    const item = await insertWithShortcode(ctx.db, "product", {
      name: "Fixture tool box",
      brandId: await findOrCreateVendor(ctx.db, "Fixture"),
      categoryId: oldCategory.id,
    });
    const line = await insertWithShortcode(ctx.db, "expense", {
      lineKind: "principal",
      name: "Fixture item",
      cost: -2000n,
      productQuantity: -1,
      productId: item.id,
      date: "2026-09-01",
      costType: "tools",
      trade: "other",
    });
    const override = await insertWithShortcode(ctx.db, "expense", {
      lineKind: "principal",
      name: "Fixture explicit purpose",
      cost: 1000n,
      productQuantity: 1,
      productId: item.id,
      spendingCategoryId: oldSpend.id,
      date: "2026-09-02",
      costType: "tools",
      trade: "other",
    });
    const request = {
      action: "products" as const,
      productIds: [parseShortcodeFor("product", item.shortcode)],
      productCategoryId: parseShortcodeFor("productCategory", target.shortcode),
    };
    const preview = await previewSpendingClassificationReview(ctx.db, request);
    expect(preview.changedExpenseCount).toBe(1);
    expect(
      (
        await unwrapDb(ctx.db).execute(
          sql`SELECT "categoryId" FROM "Product" WHERE id=${item.id}`,
          "objects",
        )
      )[0]?.categoryId,
    ).toBe(oldCategory.id);
    await applySpendingClassificationReview(context(), {
      request,
      fingerprint: preview.fingerprint,
    });
    const resolved = await unwrapDb(ctx.db).execute(
      sql`SELECT id,("costMinor"::float8 / 100) AS cost,"productQuantity",${effectiveExpenseSpendingCategorySql("e")} AS category FROM "Expense" e WHERE e.id IN (${line.id},${override.id})`,
      "objects",
    );
    expect(resolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: line.id,
          cost: -20,
          productQuantity: -1,
          category: toolsSpend.id,
        }),
        expect.objectContaining({
          id: override.id,
          cost: 10,
          productQuantity: 1,
          category: oldSpend.id,
        }),
      ]),
    );
  });

  it("refuses a stale reassignment of a Product with no Expenses", async () => {
    const source = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture old taxonomy",
    });
    const target = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture target taxonomy",
    });
    const item = await insertWithShortcode(ctx.db, "product", {
      name: "Fixture unbooked item",
      brandId: await findOrCreateVendor(ctx.db, "Fixture"),
      categoryId: source.id,
    });
    const request = {
      action: "products" as const,
      productIds: [parseShortcodeFor("product", item.shortcode)],
      productCategoryId: parseShortcodeFor("productCategory", target.shortcode),
    };
    const preview = await previewSpendingClassificationReview(ctx.db, request);
    await setFieldsFixture(ctx.db, "product", item.id, { categoryId: null });
    await expect(
      applySpendingClassificationReview(context(), {
        request,
        fingerprint: preview.fingerprint,
      }),
    ).rejects.toThrow(/changed/i);
    expect(
      (
        await unwrapDb(ctx.db).execute(
          sql`SELECT "categoryId" FROM "Product" WHERE id=${item.id}`,
          "objects",
        )
      )[0]?.categoryId,
    ).toBeNull();
  });

  // Parent edits change inherited historical money just like mapping edits;
  // both must pass the same review and preserve explicit Expense decisions.
  it("reviews subtree moves, rejects stale topology, and applies the exact parent and mapping", async () => {
    const oldSpend = parseShortcodeFor(
      "spendingCategory",
      (
        await createEntity(
          buildKernelContext(ctx.db, ctx.actor.userId),
          "spendingCategory",
          {
            name: "Fixture home spending",
          },
        )
      ).id,
    );
    const newSpend = parseShortcodeFor(
      "spendingCategory",
      (
        await createEntity(
          buildKernelContext(ctx.db, ctx.actor.userId),
          "spendingCategory",
          {
            name: "Fixture workshop spending",
          },
        )
      ).id,
    );
    const oldRoot = await createRepoIdentity(ctx, "productCategory", {
      name: "Fixture old root",
      spendingCategoryMode: "mapped",
      spendingCategoryId: oldSpend,
    });
    const newRoot = await createRepoIdentity(ctx, "productCategory", {
      name: "Fixture new root",
      spendingCategoryMode: "mapped",
      spendingCategoryId: newSpend,
    });
    const branch = await createRepoIdentity(ctx, "productCategory", {
      name: "Fixture moved branch",
      parentId: oldRoot.output.id,
    });
    const leaf = await createRepoIdentity(ctx, "productCategory", {
      name: "Fixture moved leaf",
      parentId: branch.output.id,
    });
    const item = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Fixture movable item",
        categoryId: leaf.output.id,
      }),
      ctx.actor,
    );
    const inherited = await createRepoIdentity(ctx, "expense", {
      name: "Fixture inherited refund",
      productId: item.id,
      cost: -20,
      costType: "tools",
      trade: "other",
    });
    const explicit = await createRepoIdentity(ctx, "expense", {
      name: "Fixture saved purpose",
      productId: item.id,
      cost: 10,
      costType: "tools",
      trade: "other",
      spendingCategoryId: oldSpend,
    });
    const move = {
      action: "productCategory" as const,
      productCategoryId: branch.output.id,
      parentId: newRoot.output.id,
      spendingCategoryMode: "inherit" as const,
      spendingCategoryId: null,
    };
    const ordinaryMove = () =>
      executeEntity(context(), {
        action: "update",
        entity: "productCategory",
        id: branch.output.id,
        data: fromAny({ parentId: newRoot.output.id }),
      });
    await expect(ordinaryMove()).rejects.toThrow(
      /spendingClassification.preview/,
    );
    const preview = await previewSpendingClassificationReview(ctx.db, move);
    expect(preview.changedExpenseCount).toBe(1);
    expect(preview.categoryDeltas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          spendingCategoryId: oldSpend,
          deltaCents: "2000",
        }),
        expect.objectContaining({
          spendingCategoryId: newSpend,
          deltaCents: "-2000",
        }),
      ]),
    );
    const readBranch = async () =>
      (
        await unwrapDb(ctx.db).execute(
          sql`SELECT "parentId", "spendingCategoryMode", "spendingCategoryId" FROM "ProductCategory" WHERE id=${branch.entityId}`,
          "objects",
        )
      )[0];
    expect(await readBranch()).toMatchObject({ parentId: oldRoot.entityId });

    // A reviewed topology change invalidates
    // a pending review even when its immediate allocation totals stay equal.
    const unused = await createRepoIdentity(ctx, "productCategory", {
      name: "Fixture unused branch",
      parentId: oldRoot.output.id,
    });
    const current = await previewSpendingClassificationReview(ctx.db, move);
    const unusedMove = {
      action: "productCategory" as const,
      productCategoryId: unused.output.id,
      parentId: null,
      spendingCategoryMode: "inherit" as const,
      spendingCategoryId: null,
    };
    const unusedPreview = await previewSpendingClassificationReview(
      ctx.db,
      unusedMove,
    );
    await applySpendingClassificationReview(context(), {
      request: unusedMove,
      fingerprint: unusedPreview.fingerprint,
    });
    await expect(
      applySpendingClassificationReview(context(), {
        request: move,
        fingerprint: current.fingerprint,
      }),
    ).rejects.toThrow(/changed/i);
    expect(await readBranch()).toMatchObject({ parentId: oldRoot.entityId });
    const fresh = await previewSpendingClassificationReview(ctx.db, move);
    await applySpendingClassificationReview(context(), {
      request: move,
      fingerprint: fresh.fingerprint,
    });
    expect(await readBranch()).toMatchObject({
      parentId: newRoot.entityId,
      spendingCategoryMode: "inherit",
      spendingCategoryId: null,
    });
    const resolved = await unwrapDb(ctx.db).execute(
      sql`SELECT e.id, (e."costMinor"::float8 / 100) AS cost, e."spendingCategoryId", c.shortcode AS category FROM "Expense" e LEFT JOIN "SpendingCategory" c ON c.id=${effectiveExpenseSpendingCategorySql("e")} WHERE e.id IN (${inherited.entityId}, ${explicit.entityId})`,
      "objects",
    );
    expect(resolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: inherited.entityId,
          cost: -20,
          spendingCategoryId: null,
          category: newSpend,
        }),
        expect.objectContaining({
          id: explicit.entityId,
          cost: 10,
          category: oldSpend,
        }),
      ]),
    );

    // Omission preserves the parent; explicit null moves to the root while
    // changing the mapping in that same reviewed write.
    const mappingOnly = {
      action: "productCategory" as const,
      productCategoryId: branch.output.id,
      spendingCategoryMode: "inherit" as const,
      spendingCategoryId: null,
    };
    const mappingPreview = await previewSpendingClassificationReview(
      ctx.db,
      mappingOnly,
    );
    await applySpendingClassificationReview(context(), {
      request: mappingOnly,
      fingerprint: mappingPreview.fingerprint,
    });
    expect(await readBranch()).toMatchObject({ parentId: newRoot.entityId });
    const rootMove = {
      ...move,
      parentId: null,
      spendingCategoryMode: "mapped" as const,
      spendingCategoryId: newSpend,
    };
    const rootPreview = await previewSpendingClassificationReview(
      ctx.db,
      rootMove,
    );
    await applySpendingClassificationReview(context(), {
      request: rootMove,
      fingerprint: rootPreview.fingerprint,
    });
    expect(await readBranch()).toMatchObject({
      parentId: null,
      spendingCategoryMode: "mapped",
    });
  });

  it("refuses taxonomy changes that would change Food allocation semantics", async () => {
    const food = await unwrapDb(ctx.db).query.productCategory.findFirst({
      where: {
        RAW: (category, { eq }) =>
          relationalSql(category, eq(category.feature, "food")),
      },
    });
    if (!food) throw new Error("Missing synthetic Food feature root");
    const tools = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture tools root",
    });
    const item = await insertWithShortcode(ctx.db, "product", {
      name: "Fixture food item",
      brandId: await findOrCreateVendor(ctx.db, "Fixture"),
      categoryId: food.id,
    });
    await expect(
      previewSpendingClassificationReview(ctx.db, {
        action: "products",
        productIds: [parseShortcodeFor("product", item.shortcode)],
        productCategoryId: parseShortcodeFor(
          "productCategory",
          tools.shortcode,
        ),
      }),
    ).rejects.toThrow("feature");

    const branch = await createRepoIdentity(ctx, "productCategory", {
      name: "Fixture inherited Food branch",
      parentId: taxonomyShortcode("food"),
    });
    const leaf = await createRepoIdentity(ctx, "productCategory", {
      name: "Fixture inherited Food leaf",
      parentId: branch.output.id,
    });
    await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Fixture unbooked Food item",
        categoryId: leaf.output.id,
      }),
      ctx.actor,
    );
    await expect(
      previewSpendingClassificationReview(ctx.db, {
        action: "productCategory",
        productCategoryId: branch.output.id,
        parentId: null,
        spendingCategoryMode: "inherit",
        spendingCategoryId: null,
      }),
    ).rejects.toThrow("feature");
  });

  it.each(["productCategory", "vendor"] as const)(
    "authorizes only the reviewed %s write through kernel savepoints",
    async (action) => {
      const category = await insertWithShortcode(ctx.db, "spendingCategory", {
        name: "Fixture reviewed category",
      });
      const productCategory = await insertWithShortcode(
        ctx.db,
        "productCategory",
        { name: "Fixture reviewed taxonomy" },
      );
      const product = await insertWithShortcode(ctx.db, "product", {
        name: "Fixture item",
        brandId: await findOrCreateVendor(ctx.db, "Fixture"),
        categoryId: productCategory.id,
      });
      const vendor = await insertWithShortcode(ctx.db, "vendor", {
        name: "Fixture reviewed merchant",
      });
      const purchase = await insertWithShortcode(ctx.db, "purchase", {
        date: "2026-09-01",
        vendorId: vendor.id,
      });
      const expense = await insertWithShortcode(ctx.db, "expense", {
        lineKind: "principal",
        name: "Fixture historical expense",
        date: "2026-09-01",
        cost: 1234n,
        costType: "materials",
        trade: "other",
        purchaseId: purchase.id,
        productId: action === "productCategory" ? product.id : null,
      });
      const target = parseShortcodeFor("spendingCategory", category.shortcode);
      const productCategoryCode = parseShortcodeFor(
        "productCategory",
        productCategory.shortcode,
      );
      const vendorCode = parseShortcodeFor("vendor", vendor.shortcode);
      const request =
        action === "productCategory"
          ? {
              action,
              productCategoryId: productCategoryCode,
              spendingCategoryMode: "mapped" as const,
              spendingCategoryId: target,
            }
          : {
              action,
              vendorId: vendorCode,
              spendingProfile: "restaurant" as const,
              defaultSpendingCategoryId: target,
            };
      const unreviewed = () =>
        action === "productCategory"
          ? executeEntity(context(), {
              action: "update",
              entity: "productCategory",
              id: productCategoryCode,
              data: fromAny({
                spendingCategoryMode: "blocked",
                spendingCategoryId: null,
              }),
            })
          : executeEntity(context(), {
              action: "update",
              entity: "vendor",
              id: vendorCode,
              data: fromAny({
                spendingProfile: "mixed_retail",
                defaultSpendingCategoryId: null,
              }),
            });
      await expect(unreviewed()).rejects.toThrow(
        /spendingClassification.preview/,
      );
      await expect(
        applyReviewedSpendingClassificationPolicy(context(), request),
      ).rejects.toThrow(/spendingClassification.preview/);
      const preview = await previewSpendingClassificationReview(
        ctx.db,
        request,
      );
      expect(preview.changedExpenseCount).toBe(1);
      await expect(
        applySpendingClassificationReview(context(), {
          request,
          fingerprint: preview.fingerprint,
        }),
      ).resolves.toMatchObject({ applied: true, updatedRecords: 1 });
      const resolved = await unwrapDb(ctx.db).execute(
        sql`SELECT ${effectiveExpenseSpendingCategorySql("e")} AS category FROM "Expense" e WHERE e.id=${expense.id}`,
        "objects",
      );
      expect(resolved[0]?.category).toBe(category.id);
      // A completed review cannot authorize a later unrelated request.
      await expect(unreviewed()).rejects.toThrow(
        /spendingClassification.preview/,
      );
      await expect(
        applyReviewedSpendingClassificationPolicy(context(), request),
      ).rejects.toThrow(/spendingClassification.preview/);
    },
  );

  // The fingerprint covers only Expenses the draft can affect: one that joins
  // the scope after preview stales it, an unaffected edit does not.
  it("stales a Vendor review only when an affected Expense changes", async () => {
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture dining",
    });
    const reviewed = await insertWithShortcode(ctx.db, "vendor", {
      name: "Fixture cafe",
    });
    const other = await insertWithShortcode(ctx.db, "vendor", {
      name: "Fixture hardware store",
    });
    const line = async (vendorId: typeof reviewed.id) => {
      const purchase = await insertWithShortcode(ctx.db, "purchase", {
        date: "2026-09-01",
        vendorId,
      });
      return insertWithShortcode(ctx.db, "expense", {
        lineKind: "principal",
        name: "Fixture line",
        date: "2026-09-01",
        cost: 850n,
        costType: "materials",
        trade: "other",
        purchaseId: purchase.id,
      });
    };
    await line(reviewed.id);
    const unrelated = await line(other.id);
    const joining = await line(other.id);
    const request = {
      action: "vendor" as const,
      vendorId: parseShortcodeFor("vendor", reviewed.shortcode),
      spendingProfile: "restaurant" as const,
      defaultSpendingCategoryId: parseShortcodeFor(
        "spendingCategory",
        category.shortcode,
      ),
    };
    const preview = await previewSpendingClassificationReview(ctx.db, request);
    expect(preview.changedExpenseCount).toBe(1);
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Expense" SET "costMinor"=900 WHERE id=${unrelated.id}`,
    );
    const stillCurrent = await previewSpendingClassificationReview(
      ctx.db,
      request,
    );
    expect(stillCurrent.fingerprint).toBe(preview.fingerprint);
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Purchase" SET "vendorId"=${reviewed.id} WHERE id=${joining.purchaseId}`,
    );
    await expect(
      applySpendingClassificationReview(context(), {
        request,
        fingerprint: preview.fingerprint,
      }),
    ).rejects.toThrow(/changed/i);
  });

  it("previews exact money without writes and rejects changed history before apply", async () => {
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture gifts",
    });
    const expense = await insertWithShortcode(ctx.db, "expense", {
      lineKind: "principal",
      name: "Fixture purchase",
      cost: 1234n,
      date: "2026-09-01",
      costType: "materials",
      trade: "other",
    });
    const request = {
      action: "expenses" as const,
      expenseIds: [parseShortcodeFor("expense", expense.shortcode)],
      spendingCategoryId: parseShortcodeFor(
        "spendingCategory",
        category.shortcode,
      ),
    };
    const preview = await previewSpendingClassificationReview(ctx.db, request);
    expect(preview.changedExpenseCount).toBe(1);
    expect(preview.categoryDeltas).toContainEqual(
      expect.objectContaining({
        spendingCategoryId: request.spendingCategoryId,
        beforeCents: "0",
        afterCents: "1234",
        deltaCents: "1234",
      }),
    );
    const before = await unwrapDb(ctx.db).execute(
      sql`SELECT "spendingCategoryId" FROM "Expense" WHERE id=${expense.id}`,
      "objects",
    );
    expect(before[0]?.spendingCategoryId).toBeNull();
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Expense" SET "costMinor"=1500 WHERE id=${expense.id}`,
    );
    await expect(
      applySpendingClassificationReview(context(), {
        request,
        fingerprint: preview.fingerprint,
      }),
    ).rejects.toThrow(/changed/i);
    const after = await unwrapDb(ctx.db).execute(
      sql`SELECT "spendingCategoryId" FROM "Expense" WHERE id=${expense.id}`,
      "objects",
    );
    expect(after[0]?.spendingCategoryId).toBeNull();
  });
});
