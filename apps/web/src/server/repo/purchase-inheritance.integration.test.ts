import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { expenseChargeContextOut } from "@cubby/schemas/project";
import { purchaseUpdateData } from "@cubby/schemas/purchase";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { entityKernelContextSchema } from "~/server/entity-kernel";
import { explainField } from "~/server/field-explanation-browser.server";
import { getEntityRecommendations } from "~/server/services/entity-recommendations.service";
import { createTestRequestContext } from "~/server/testing/request-context";
import { expenseChargeContextWorkflow } from "~/server/workflows/expense.server";

import { getDb } from "./database-helpers";
import { getExpenseByShortcode, updateExpense } from "./expense";
import { resolveDraftExpenseFields } from "./expense-inheritance";
import {
  deletePurchases,
  getPurchaseByID,
  mergePurchases,
  updatePurchase,
} from "./purchase";
import { insertWithShortcode } from "./shortcode-utils";

const fixtureDate = "2026-09-20";
describe("purchase inheritance lifecycle", () => {
  const ctx = withTestDb();
  const fixture = async () => {
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Inheritance fixture vendor",
    });
    const first = await insertWithShortcode(ctx.db, "project", {
      name: "First fixture project",
      defaultTrade: "building",
    });
    const second = await insertWithShortcode(ctx.db, "project", {
      name: "Second fixture project",
      defaultTrade: "plumbing",
    });
    const source = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: fixtureDate,
      defaultProjectId: first.id,
    });
    const keeper = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: fixtureDate,
      defaultProjectId: second.id,
    });
    const item = await insertWithShortcode(ctx.db, "expense", {
      name: "Inherited fixture item",
      date: fixtureDate,
      cost: 10,
      costType: "materials",
      lineKind: "principal",
      trade: null,
      purchaseId: source.id,
    });
    return { first, second, source, keeper, item };
  };

  it("updates inheriting reads live and refuses a source change that loses required trade", async () => {
    const { source, second, item } = await fixture();
    const code = parseShortcodeFor("expense", item.shortcode);
    expect(await getExpenseByShortcode(ctx.db, code)).toMatchObject({
      trade: "building",
      fieldResolutions: { projectId: { mode: "inherit", storedValue: null } },
    });
    await updatePurchase(
      ctx.db,
      parseShortcodeFor("purchase", source.shortcode),
      purchaseUpdateData.parse({ defaultProjectId: second.shortcode }),
      ctx.actor,
    );
    expect(await getExpenseByShortcode(ctx.db, code)).toMatchObject({
      projectId: second.shortcode,
      trade: "plumbing",
    });
    await expect(
      updatePurchase(
        ctx.db,
        parseShortcodeFor("purchase", source.shortcode),
        purchaseUpdateData.parse({ defaultProjectId: null }),
        ctx.actor,
      ),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });
    expect(await getExpenseByShortcode(ctx.db, code)).toMatchObject({
      projectId: second.shortcode,
      trade: "plumbing",
    });
  });

  it("reads inherited purchase context and explains allocated shares without scalar overrides", async () => {
    const { source, item, first, second } = await fixture();
    await insertWithShortcode(ctx.db, "expense", {
      name: "Second project item",
      date: fixtureDate,
      cost: 40,
      costType: "materials",
      lineKind: "principal",
      purchaseId: source.id,
      projectId: second.id,
    });
    const charge = await insertWithShortcode(ctx.db, "expense", {
      name: "Shared fixture tax",
      date: fixtureDate,
      cost: 1,
      costType: "materials",
      lineKind: "tax",
      trade: "building",
      purchaseId: source.id,
    });
    const code = parseShortcodeFor("expense", item.shortcode);
    const result = expenseChargeContextOut.parse(
      await expenseChargeContextWorkflow(ctx.db, code),
    );
    expect(result?.siblings).toHaveLength(2);
    await expect(
      getEntityRecommendations(ctx.db, {
        entityType: "expense",
        entityId: code,
      }),
    ).resolves.toMatchObject({ source: { entityId: code } });
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    for (const surface of ["detail", "list"] as const) {
      const explanation = await explainField(context, {
        entityType: "expense",
        entityId: charge.shortcode,
        field: "projectId",
        surface,
      });
      expect(explanation.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            entity: { entityType: "project", entityId: first.shortcode },
            value: expect.objectContaining({ amount: 0.2 }),
          }),
          expect.objectContaining({
            entity: { entityType: "project", entityId: second.shortcode },
            value: expect.objectContaining({ amount: 0.8 }),
          }),
        ]),
      );
      expect(explanation.sources.map((s) => s.label)).not.toContain(
        "Stored override",
      );
    }
    await expect(
      getEntityRecommendations(ctx.db, {
        entityType: "expense",
        entityId: charge.shortcode,
      }),
    ).resolves.toMatchObject({ groups: [] });
  });

  it("sums fractional purchase amounts before converting to floating point", async () => {
    const { source } = await fixture();
    for (const cost of [0.1, 0.2]) {
      await insertWithShortcode(ctx.db, "expense", {
        name: "Fractional item",
        date: fixtureDate,
        cost,
        costType: "materials",
        lineKind: "principal",
        purchaseId: source.id,
      });
    }
    expect((await getPurchaseByID(ctx.db, source.id)).expenseTotal).toBe(10.3);
  });

  it("preserves principal attribution when its purchase link is explicitly detached", async () => {
    const { first, item } = await fixture();
    const code = parseShortcodeFor("expense", item.shortcode);
    await updateExpense(ctx.db, code, { purchaseId: null }, ctx.actor);
    expect(await getExpenseByShortcode(ctx.db, code)).toMatchObject({
      purchaseId: null,
      projectId: first.shortcode,
      trade: "building",
      fieldResolutions: {
        projectId: { mode: "explicit" },
        trade: { mode: "explicit" },
      },
    });
  });

  it("resets trade against the effective explicit project", async () => {
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Trade reset fixture vendor",
    });
    const purchaseProject = await insertWithShortcode(ctx.db, "project", {
      name: "Purchase fallback project",
      defaultTrade: "plumbing",
    });
    const explicitProject = await insertWithShortcode(ctx.db, "project", {
      name: "Explicit expense project",
      defaultTrade: "building",
    });
    const source = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: fixtureDate,
      defaultProjectId: purchaseProject.id,
    });
    const item = await insertWithShortcode(ctx.db, "expense", {
      name: "Explicit trade reset item",
      date: fixtureDate,
      cost: 10,
      costType: "materials",
      lineKind: "principal",
      projectId: explicitProject.id,
      trade: "electrical",
      purchaseId: source.id,
    });
    const expenseCode = parseShortcodeFor("expense", item.shortcode);

    expect(await getExpenseByShortcode(ctx.db, expenseCode)).toMatchObject({
      fieldResolutions: { trade: { fallbackValue: "building" } },
    });
    expect(
      await resolveDraftExpenseFields(ctx.db, {
        projectId: explicitProject.shortcode,
        purchaseId: source.shortcode,
        trade: "electrical",
      }),
    ).toMatchObject({ trade: { fallbackValue: "building" } });

    expect(
      await resolveDraftExpenseFields(ctx.db, {
        name: "Sales tax",
        lineKind: "auto",
        purchaseId: source.shortcode,
      }),
    ).toMatchObject({ projectId: { mode: "allocated", value: null } });

    await updateExpense(ctx.db, expenseCode, { trade: null }, ctx.actor);
    expect(await getExpenseByShortcode(ctx.db, expenseCode)).toMatchObject({
      projectId: explicitProject.shortcode,
      trade: "building",
      fieldResolutions: { trade: { mode: "inherit" } },
    });
  });

  it("refuses to offer trade reset on a principal expense with no fallback trade", async () => {
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "No fallback trade fixture vendor",
    });
    const source = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: fixtureDate,
    });
    const item = await insertWithShortcode(ctx.db, "expense", {
      name: "No fallback trade item",
      date: fixtureDate,
      cost: 10,
      costType: "materials",
      lineKind: "principal",
      trade: "electrical",
      purchaseId: source.id,
    });
    const expenseCode = parseShortcodeFor("expense", item.shortcode);

    expect(await getExpenseByShortcode(ctx.db, expenseCode)).toMatchObject({
      fieldResolutions: {
        trade: {
          storedValue: "electrical",
          fallbackValue: null,
          canReset: false,
        },
      },
    });
    expect(
      await resolveDraftExpenseFields(ctx.db, {
        purchaseId: source.shortcode,
        trade: "electrical",
      }),
    ).toMatchObject({
      trade: {
        storedValue: "electrical",
        fallbackValue: null,
        canReset: false,
      },
    });
  });

  it("offers trade reset on a principal expense whose purchase supplies a default trade", async () => {
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Purchase default trade fixture vendor",
    });
    const source = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: fixtureDate,
      defaultTrade: "plumbing",
    });
    const item = await insertWithShortcode(ctx.db, "expense", {
      name: "Purchase default trade item",
      date: fixtureDate,
      cost: 10,
      costType: "materials",
      lineKind: "principal",
      trade: "electrical",
      purchaseId: source.id,
    });
    const expenseCode = parseShortcodeFor("expense", item.shortcode);

    expect(await getExpenseByShortcode(ctx.db, expenseCode)).toMatchObject({
      fieldResolutions: {
        trade: {
          storedValue: "electrical",
          fallbackValue: "plumbing",
          canReset: true,
        },
      },
    });
  });

  it("preserves source item attribution through a merge and keeps the keeper default", async () => {
    const { first, second, source, keeper, item } = await fixture();
    await mergePurchases(
      ctx.db,
      {
        keepId: parseShortcodeFor("purchase", keeper.shortcode),
        mergeIds: [parseShortcodeFor("purchase", source.shortcode)],
      },
      ctx.actor,
    );
    expect(
      await getExpenseByShortcode(
        ctx.db,
        parseShortcodeFor("expense", item.shortcode),
      ),
    ).toMatchObject({
      projectId: first.shortcode,
      trade: "building",
      purchaseId: keeper.shortcode,
    });
    expect(
      await getDb(ctx.db).query.purchase.findFirst({
        where: (table, { eq }) => eq(table.id, keeper.id),
      }),
    ).toMatchObject({ defaultProjectId: second.id });
  });

  it("refuses a merge that cannot preserve an unassigned principal", async () => {
    const { source, keeper, item } = await fixture();
    await updatePurchase(
      ctx.db,
      parseShortcodeFor("purchase", source.shortcode),
      purchaseUpdateData.parse({
        defaultProjectId: null,
        defaultTrade: "building",
      }),
      ctx.actor,
    );
    await expect(
      mergePurchases(
        ctx.db,
        {
          keepId: parseShortcodeFor("purchase", keeper.shortcode),
          mergeIds: [parseShortcodeFor("purchase", source.shortcode)],
        },
        ctx.actor,
      ),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });
    expect(
      await getExpenseByShortcode(
        ctx.db,
        parseShortcodeFor("expense", item.shortcode),
      ),
    ).toMatchObject({ projectId: null, purchaseId: source.shortcode });
  });

  it("materializes inherited attribution on detach and never orphans a charge", async () => {
    const { first, source, keeper, item } = await fixture();
    await deletePurchases(
      ctx.db,
      [parseShortcodeFor("purchase", source.shortcode)],
      ctx.actor,
    );
    expect(
      await getExpenseByShortcode(
        ctx.db,
        parseShortcodeFor("expense", item.shortcode),
      ),
    ).toMatchObject({
      projectId: first.shortcode,
      trade: "building",
      purchaseId: null,
    });
    await insertWithShortcode(ctx.db, "expense", {
      name: "Shared fee",
      date: fixtureDate,
      cost: 1,
      costType: "services",
      lineKind: "fee",
      trade: null,
      purchaseId: keeper.id,
    });
    await expect(
      deletePurchases(
        ctx.db,
        [parseShortcodeFor("purchase", keeper.shortcode)],
        ctx.actor,
      ),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });
    expect(
      await getDb(ctx.db).query.purchase.findFirst({
        where: (table, { eq }) => eq(table.id, keeper.id),
      }),
    ).toMatchObject({ deletedAt: null });
  });
});
