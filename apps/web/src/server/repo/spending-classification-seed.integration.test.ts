import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { expense } from "~/server/db/schema";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { createTestRequestContext } from "~/server/testing/request-context";

import { unwrapDb } from "./database-helpers";
import { insertWithShortcode } from "./shortcode-utils";
import {
  applySpendingClassificationSeed,
  previewExpenseProjectRoundingRedistribution,
  previewSpendingClassificationSeed,
} from "./spending-classification-seed";

const ctx = withTestDb();
const context = () =>
  entityKernelContextSchema.parse(
    createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
  );
const manifest = {
  categories: [
    {
      key: "root",
      name: "Synthetic seed root",
      aliases: ["Synthetic root alias"],
      parentKey: null,
    },
    {
      key: "child",
      name: "Synthetic seed child",
      aliases: ["Synthetic child alias"],
      parentKey: "root",
    },
  ],
  mappings: [
    { productCategoryName: "Synthetic seed taxonomy", categoryKey: "child" },
  ],
};

describe("reviewed spending taxonomy seed", () => {
  it("previews without writes and applies audited aliases, hierarchy and mappings idempotently", async () => {
    await executeEntity(context(), {
      action: "create",
      entity: "spendingCategory",
      data: {
        name: "Synthetic seed root",
        aliases: ["Synthetic existing root alias"],
        parentId: null,
        evidenceExpectation: "unknown",
        productExpectation: "unknown",
      },
    });
    const taxonomy = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Synthetic seed taxonomy",
    });
    const blocked = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Synthetic blocked taxonomy",
      spendingCategoryMode: "blocked",
    });
    const legacy = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic ambiguous legacy",
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic seed vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-20",
      spendingCategoryId: legacy.id,
    });
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic seed product",
      manufacturer: "Synthetic",
      categoryId: taxonomy.id,
    });
    await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic seed expense",
      cost: 12.34,
      date: "2026-09-20",
      costType: "materials",
      productId: product.id,
      purchaseId: purchase.id,
    });
    const input = {
      ...manifest,
      mappings: [
        ...manifest.mappings,
        { productCategoryName: blocked.name, categoryKey: "child" },
      ],
    };
    const preview = await previewSpendingClassificationSeed(ctx.db, input);
    expect(preview.categoryDeltas).toContainEqual(
      expect.objectContaining({
        categoryKey: "child",
        name: "Synthetic seed child",
        beforeCents: "0",
        afterCents: "1234",
        deltaCents: "1234",
      }),
    );
    expect(
      preview.categoryDeltas.reduce(
        (sum, row) => sum + BigInt(row.deltaCents),
        0n,
      ),
    ).toBe(0n);
    expect(preview.categoryDeltas).toContainEqual(
      expect.objectContaining({
        spendingCategoryId: legacy.shortcode,
        deltaCents: "-1234",
      }),
    );
    expect(preview.newCategories).toBe(1);
    expect(preview.plannedMappings).toBe(1);
    expect(preview.preservedMappings).toBe(1);
    const before = await unwrapDb(ctx.db).execute(
      sql`SELECT count(*)::int AS count FROM "SpendingCategory" WHERE name='Synthetic seed root' AND "deletedAt" IS NULL`,
    );
    expect(before.rows[0]?.count).toBe(1);
    const applied = await applySpendingClassificationSeed(
      context(),
      input,
      preview.fingerprint,
    );
    expect(applied).toMatchObject({ createdCategories: 1, updatedMappings: 1 });
    const rows = await unwrapDb(ctx.db).execute(
      sql`SELECT c.name,c.aliases,c."parentId",parent.name AS "parentName" FROM "SpendingCategory" c LEFT JOIN "SpendingCategory" parent ON parent.id=c."parentId" AND parent."deletedAt" IS NULL WHERE c.name IN ('Synthetic seed root','Synthetic seed child') AND c."deletedAt" IS NULL ORDER BY c.name`,
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({
        name: "Synthetic seed child",
        parentName: "Synthetic seed root",
        aliases: ["Synthetic child alias"],
        parentId: expect.any(String),
      }),
      expect.objectContaining({
        name: "Synthetic seed root",
        aliases: expect.arrayContaining([
          "Synthetic root alias",
          "Synthetic existing root alias",
        ]),
        parentId: null,
      }),
    ]);
    const saved = await unwrapDb(ctx.db).execute(
      sql`SELECT "spendingCategoryMode" AS mode FROM "ProductCategory" WHERE id=${taxonomy.id}`,
    );
    expect(saved.rows[0]?.mode).toBe("mapped");
    const unchanged = await unwrapDb(ctx.db).execute(
      sql`SELECT "spendingCategoryId" AS category FROM "Purchase" WHERE id=${purchase.id}`,
    );
    expect(unchanged.rows[0]?.category).toBe(legacy.id);
    const second = await previewSpendingClassificationSeed(ctx.db, input);
    expect(second).toMatchObject({
      newCategories: 0,
      plannedMappings: 0,
      preservedMappings: 2,
    });
    expect(
      await applySpendingClassificationSeed(
        context(),
        input,
        second.fingerprint,
      ),
    ).toMatchObject({ createdCategories: 0, updatedMappings: 0 });
    const audit = await unwrapDb(ctx.db).execute(
      sql`SELECT count(*)::int AS count FROM "AuditLog" WHERE "entityId"=${taxonomy.id} AND action='update'`,
    );
    expect(Number(audit.rows[0]?.count)).toBeGreaterThan(0);
  });

  it("refuses missing or duplicate exact taxonomy identities and alias collisions", async () => {
    await expect(
      previewSpendingClassificationSeed(ctx.db, manifest),
    ).rejects.toThrow(/missing.*taxonomy/i);
    await insertWithShortcode(ctx.db, "productCategory", {
      name: "Synthetic seed taxonomy",
    });
    await insertWithShortcode(ctx.db, "productCategory", {
      name: "Synthetic seed taxonomy",
    });
    await expect(
      previewSpendingClassificationSeed(ctx.db, manifest),
    ).rejects.toThrow(/ambiguous.*taxonomy/i);
    await expect(
      previewSpendingClassificationSeed(ctx.db, {
        categories: [
          {
            key: "one",
            name: "Synthetic collision one",
            aliases: ["Synthetic shared alias"],
            parentKey: null,
          },
          {
            key: "two",
            name: "Synthetic collision two",
            aliases: ["Synthetic shared alias"],
            parentKey: null,
          },
        ],
        mappings: [],
      }),
    ).rejects.toThrow(/alias.*ambiguous|ambiguous.*alias/i);
    await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic inherited alias owner",
      aliases: ["Synthetic occupied alias"],
    });
    await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic occupied alias",
    });
    await expect(
      previewSpendingClassificationSeed(ctx.db, {
        categories: [
          {
            key: "owner",
            name: "Synthetic inherited alias owner",
            aliases: ["Synthetic safe addition"],
            parentKey: null,
          },
        ],
        mappings: [],
      }),
    ).rejects.toThrow(/alias.*ambiguous|ambiguous.*alias/i);
  });

  it("rejects changed taxonomy and history before any seed writes", async () => {
    await insertWithShortcode(ctx.db, "productCategory", {
      name: "Synthetic seed taxonomy",
    });
    const row = await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic seed history",
      cost: 1,
      date: "2026-09-20",
      costType: "materials",
    });
    const preview = await previewSpendingClassificationSeed(ctx.db, manifest);
    await unwrapDb(ctx.db)
      .update(expense)
      .set({ cost: 2 })
      .where(eq(expense.id, row.id));
    await expect(
      applySpendingClassificationSeed(context(), manifest, preview.fingerprint),
    ).rejects.toThrow(/changed|stale/i);
    const unchanged = await unwrapDb(ctx.db).execute(
      sql`SELECT count(*)::int AS count FROM "SpendingCategory" WHERE name='Synthetic seed root' AND "deletedAt" IS NULL`,
    );
    expect(unchanged.rows[0]?.count).toBe(0);
  });

  it("reports historical Project cent redistribution without changing Expense money", async () => {
    const projects = await Promise.all(
      ["One", "Two"].map((name) =>
        insertWithShortcode(ctx.db, "project", {
          name: `Synthetic rounding ${name}`,
        }),
      ),
    );
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic rounding vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-20",
    });
    const items = await Promise.all(
      [0, 1, 2].map((index) =>
        insertWithShortcode(ctx.db, "expense", {
          name: `Synthetic rounding item ${index}`,
          cost: 1,
          date: "2026-09-20",
          costType: "materials",
          purchaseId: purchase.id,
          projectId: projects[0]!.id,
        }),
      ),
    );
    const winner = [...items].sort((a, b) => a.id.localeCompare(b.id))[0]!;
    await unwrapDb(ctx.db)
      .update(expense)
      .set({ projectId: projects[1]!.id })
      .where(eq(expense.id, winner.id));
    const fee = await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic rounding fee",
      cost: 0.01,
      date: "2026-09-20",
      lineKind: "fee",
      costType: "materials",
      purchaseId: purchase.id,
    });
    const result = await previewExpenseProjectRoundingRedistribution(ctx.db, [
      fee.id,
    ]);
    expect(result).toEqual({
      changedExpenseCount: 1,
      changedProjectCount: 2,
      absoluteProjectDeltaCents: "2",
      totalBeforeCents: "1",
      totalAfterCents: "1",
    });
  });
});
