import { externalIdInputs } from "@cubby/schemas/external-id";
import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { fieldResolutionSchema } from "@cubby/schemas/field-resolution";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { itemizationExpectation } from "@cubby/schemas/purchase-evidence-policy";
import type { VendorSpendingProfile } from "@cubby/schemas/spending-classification";
import { sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import {
  taxonomyId,
  taxonomyShortcode,
} from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, unwrapDb } from "~/server/db/helpers";
import {
  externalSource,
  financialTransactionAllocation,
} from "~/server/db/schema";
import {
  createExpense,
  updateExpense,
} from "~/server/domains/expense/repo/crud";
import { expenseSpendingCategoryResolutionSql } from "~/server/domains/expense/repo/expense-category-resolution";
import { createInventoryEntry } from "~/server/domains/inventory/repo/crud";
import { createLedgerParty } from "~/server/domains/ledger-party/repo/ledger-party";
import { loadProductPricing } from "~/server/domains/product/repo/pricing";
import { resolveProductIdentifierSource } from "~/server/domains/product/repo/product-identifier-source";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { explainField } from "~/server/generic/field-explanation/operations/field-explanation.server";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { drainStoredDerived } from "~/server/testing/background-queue";
import {
  createLocationFixture,
  createProductIdentityFixture,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

describe("derived field explanations against canonical records", () => {
  const ctx = withTestDb();

  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );

  it("explains the published beneficiary revision separately from the live comparison", async () => {
    const first = await createRepoEntity(ctx, "ledgerParty", {
      name: "Published beneficiary",
    });
    const second = await createRepoEntity(ctx, "ledgerParty", {
      name: "Live beneficiary",
    });
    const line = await createRepoEntity(ctx, "expense", {
      name: "Published beneficiary evidence",
      trade: "other",
      cost: 4,
      beneficiaries: [{ partyId: first.output.id, weight: 2 }],
    });
    await drainStoredDerived(ctx.db);
    await updateExpense(
      ctx.db,
      line.output.id,
      { beneficiaries: [{ partyId: second.output.id, weight: 3 }] },
      ctx.actor,
    );
    const explanation = await explainField(context(), {
      entityKind: "expense",
      entityId: line.output.id,
      field: "effectiveBeneficiaries",
      surface: "detail",
    });
    expect(fieldValueOf(explanation.envelope)).toEqual([
      expect.objectContaining({ partyId: first.output.id, weight: "2" }),
    ]);
    expect(explanation.envelope.result).toMatchObject({
      kind: "cached",
      freshness: "stale",
    });
    expect(JSON.stringify(explanation.sources)).toContain(first.output.id);
    expect(JSON.stringify(explanation.sources)).not.toContain(second.output.id);
    expect(explanation.comparison.kind).toBe("unavailable");
    expect(explanation.resolutionEvidence).toBeNull();
    const diagnostic = await explainField(context(), {
      entityKind: "expense",
      entityId: line.output.id,
      field: "effectiveBeneficiaries",
      surface: "detail",
      displayedResult: explanation.envelope.result,
      diagnostic: true,
    });
    expect(diagnostic.comparison).toMatchObject({
      kind: "available",
      result: {
        decision: {
          outcome: {
            kind: "value",
            value: [expect.objectContaining({ partyId: second.output.id })],
          },
        },
      },
    });
    if (explanation.envelope.result.kind !== "cached")
      throw new Error("Expected a retained publication");
    const mismatched = await explainField(context(), {
      entityKind: "expense",
      entityId: line.output.id,
      field: "effectiveBeneficiaries",
      surface: "detail",
      displayedResult: {
        ...explanation.envelope.result,
        decision: {
          ...explanation.envelope.result.decision,
          outcome: { kind: "empty", reason: "unset" },
        },
      },
    });
    expect(mismatched.publication?.kind).toBe("superseded");
    expect(mismatched.sources).toEqual([]);
    // A replaced publication cannot explain the browser's still-visible old value.
    await drainStoredDerived(ctx.db);
    const superseded = await explainField(context(), {
      entityKind: "expense",
      entityId: line.output.id,
      field: "effectiveBeneficiaries",
      surface: "detail",
      displayedResult: explanation.envelope.result,
    });
    expect(superseded.publication?.kind).toBe("superseded");
    expect(superseded.sources).toEqual([]);
  });

  async function explainExpenseCategory(line: {
    id: string;
    shortcode: string;
  }) {
    const result = await unwrapDb(ctx.db).execute(sql`
      SELECT ${expenseSpendingCategoryResolutionSql("e")} AS resolution
      FROM "Expense" e WHERE e.id=${line.id} AND e."deletedAt" IS NULL`);
    const canonical = fieldResolutionSchema.parse(result.rows[0]?.resolution);
    const explanation = await explainField(context(), {
      entityKind: "expense",
      entityId: parseShortcodeFor("expense", line.shortcode),
      field: "spendingCategoryId",
      surface: "list",
    });
    expect(fieldValueOf(explanation.envelope)).toEqual(canonical.value);
    expect(explanation).not.toHaveProperty("resolution");
    expect(explanation).not.toHaveProperty("derived");
    return explanation;
  }

  async function categoryContextFixture(profile: VendorSpendingProfile) {
    const mapped = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic grocery mapping",
    });
    const contextual = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic dining context",
    });
    const deliberate = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic deliberate purpose",
    });
    const category = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Synthetic prepared food",
      parentId: taxonomyId("food"),
      spendingCategoryMode: "mapped",
      spendingCategoryId: mapped.id,
    });
    const productRecord = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic food item",
        categoryId: parseShortcodeFor("productCategory", category.shortcode),
      }),
      ctx.actor,
    );
    const product = { id: productRecord.entityId, shortcode: productRecord.id };
    const vendorRecord = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic category context vendor",
      spendingProfile: profile,
      defaultSpendingCategoryId: parseShortcodeFor(
        "spendingCategory",
        contextual.shortcode,
      ),
    });
    const vendor = {
      id: vendorRecord.entityId,
      shortcode: vendorRecord.output.id,
    };
    const purchaseRecord = await createRepoEntity(ctx, "purchase", {
      vendorId: vendorRecord.output.id,
      spendingCategoryId: parseShortcodeFor(
        "spendingCategory",
        deliberate.shortcode,
      ),
    });
    const purchase = {
      id: purchaseRecord.entityId,
      shortcode: purchaseRecord.output.id,
    };
    const lineRecord = await createRepoEntity(ctx, "expense", {
      name: "Synthetic category context line",
      trade: "other",
      lineKind: "principal",
      date: "2026-09-01",
      cost: 8,
      costType: "materials",
      productId: productRecord.id,
      purchaseId: purchaseRecord.output.id,
    });
    const line = { id: lineRecord.entityId, shortcode: lineRecord.output.id };
    return {
      mapped,
      contextual,
      deliberate,
      category,
      product,
      vendor,
      purchase,
      line,
    };
  }

  it("links registered identifier source owners and preserves unowned slugs", async () => {
    const supplier = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic evidence supplier",
      website: "https://shop.example.test",
    });
    const source = await resolveProductIdentifierSource(ctx.db, {
      url: "https://shop.example.test/catalog/item",
      vendorId: supplier.entityId,
    });
    const offlineSupplier = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic supplier without a website",
      website: null,
      browserDomains: [],
    });
    const offlineSource = await resolveProductIdentifierSource(ctx.db, {
      vendorId: offlineSupplier.entityId,
    });
    // Prefix-shaped slugs do not establish ownership, and an external ID
    // that equals a registered slug remains an identifier rather than a link.
    const unownedSource = "vendor-00000000-0000-4000-8000-000000000001";
    await getDb(ctx.db).insert(externalSource).values({
      slug: unownedSource,
      label: "Synthetic unowned source",
      vendorId: null,
    });
    const item = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        externalIds: externalIdInputs.parse([
          { source, kind: "retailer_sku", externalId: source },
          {
            source: unownedSource,
            kind: "retailer_sku",
            externalId: "SYNTHETIC-UNOWNED",
          },
          {
            source: offlineSource,
            kind: "retailer_sku",
            externalId: offlineSource,
          },
          {
            source: offlineSource,
            kind: "retailer_sku",
            externalId: offlineSupplier.entityId,
            isPrimary: false,
          },
        ]),
      }),
      ctx.actor,
    );
    const explanation = await explainField(context(), {
      entityKind: "product",
      entityId: item.id,
      field: "primaryGtin",
      surface: "list",
    });
    expect(explanation.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Product identifiers",
          value: expect.arrayContaining([
            expect.objectContaining({
              source: supplier.output.id,
              externalId: source,
            }),
            expect.objectContaining({ source: unownedSource }),
            expect.objectContaining({
              source: offlineSupplier.output.id,
              externalId: offlineSource,
            }),
            expect.objectContaining({
              source: offlineSupplier.output.id,
              externalId: offlineSupplier.entityId,
            }),
          ]),
        }),
      ]),
    );
  });

  // A field's recorded Sources must stay visible after the value changes, but
  // must not read as supporting the new value.

  // Lazy explanations must expose the same winning ancestor and fallback as
  // canonical reads, even when an Expense override hides that mapping.
  it("explains Product Category ancestry behind an Expense override", async () => {
    const mapped = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture tools",
    });
    const explicit = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture gifts",
    });
    const root = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture older mapping",
      spendingCategoryMode: "mapped",
      spendingCategoryId: explicit.id,
    });
    const parent = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture tools",
      parentId: root.id,
      spendingCategoryMode: "mapped",
      spendingCategoryId: mapped.id,
    });
    const child = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture tool storage",
      parentId: parent.id,
    });
    const item = await insertWithShortcode(ctx.db, "product", {
      name: "Fixture toolbox",
      brandId: await findOrCreateVendor(ctx.db, "Fixture"),
      categoryId: child.id,
    });
    const line = await insertWithShortcode(ctx.db, "expense", {
      lineKind: "principal",
      name: "Fixture gift",
      cost: 15,
      date: "2026-09-01",
      productId: item.id,
      spendingCategoryId: explicit.id,
      costType: "tools",
      trade: "other",
    });
    const explanation = await explainExpenseCategory(line);
    expect(explanation.envelope).toMatchObject({
      current: { assignment: { kind: "value", value: explicit.shortcode } },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "value", value: explicit.shortcode },
          provenance: { kind: "own" },
        },
      },
    });
    expect(explanation.resolutionEvidence?.chain.rows[0]?.state?.kind).toBe(
      "done",
    );
    expect(
      explanation.resolutionEvidence?.chain.rows.find(
        (row) => row.id === parent.shortcode,
      )?.trailing,
    ).toBe("Fixture tools");
    expect(
      explanation.resolutionEvidence?.chain.rows.flatMap((row) =>
        row.id ? [row.id] : [],
      ),
    ).toEqual([child.shortcode, parent.shortcode, root.shortcode]);
    expect(
      explanation.resolutionEvidence?.chain.rows.find(
        (row) => row.id === root.shortcode,
      ),
    ).toMatchObject({
      trailing: "Fixture gifts",
      state: { kind: "skipped", label: "Evaluated · overridden" },
    });
    expect(explanation.resolutionEvidence).toMatchObject({
      fallbackSource: {
        entityKind: "productCategory",
        entityId: parent.shortcode,
      },
    });
  });

  // Category explanation must follow the SQL owner's eligibility even for
  // assigned alternatives that lose to context, a block, or a stored reference.
  it.each([
    { profile: "restaurant", contextWins: true },
    { profile: "coffee_shop", contextWins: true },
    { profile: "mixed_retail", contextWins: false },
    { profile: "food_retail", contextWins: false },
  ] satisfies { profile: VendorSpendingProfile; contextWins: boolean }[])(
    "explains $profile food context versus retail category mapping",
    async ({ profile, contextWins }) => {
      const f = await categoryContextFixture(profile);
      const explanation = await explainExpenseCategory(f.line);
      expect(fieldValueOf(explanation.envelope)).toBe(
        contextWins ? f.contextual.shortcode : f.mapped.shortcode,
      );
      expect(explanation.resolutionEvidence?.fallbackSource?.entityId).toBe(
        contextWins ? f.vendor.shortcode : f.category.shortcode,
      );
      expect(
        explanation.resolutionEvidence?.chain.rows.find(
          (row) => row.title === "Vendor food context",
        )?.state,
      ).toEqual(
        contextWins
          ? { kind: "done", label: "Used" }
          : { kind: "skipped", label: "Not applicable to this line" },
      );
      expect(
        explanation.resolutionEvidence?.chain.rows.find(
          (row) => row.id === f.category.shortcode,
        )?.state,
      ).toEqual(
        contextWins
          ? { kind: "skipped", label: "Not applicable to this line" }
          : { kind: "done", label: "Used" },
      );
      expect(
        explanation.resolutionEvidence?.chain.rows.find(
          (row) => row.id === f.purchase.shortcode,
        )?.state,
      ).toEqual({ kind: "skipped", label: "Evaluated · overridden" });
    },
  );

  it("explains a blocked mapping without suppressing a deliberate Purchase fallback", async () => {
    const f = await categoryContextFixture("restaurant");
    const blocked = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Synthetic blocked food mapping",
      parentId: f.category.id,
      spendingCategoryMode: "blocked",
    });
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Product" SET "categoryId"=${blocked.id} WHERE id=${f.product.id}`,
    );
    const explanation = await explainExpenseCategory(f.line);
    expect(fieldValueOf(explanation.envelope)).toBe(f.deliberate.shortcode);
    expect(explanation.resolutionEvidence?.fallbackSource?.entityId).toBe(
      f.purchase.shortcode,
    );
    expect(
      explanation.resolutionEvidence?.chain.rows.find(
        (row) => row.id === blocked.shortcode,
      ),
    ).toMatchObject({ trailing: "Blocked", state: { kind: "skipped" } });
    expect(
      explanation.resolutionEvidence?.chain.rows.find(
        (row) => row.id === f.category.shortcode,
      ),
    ).toMatchObject({
      trailing: "Synthetic grocery mapping",
      state: { kind: "skipped" },
    });
    expect(
      explanation.resolutionEvidence?.chain.rows
        .filter((row) => row.entity === "vendor")
        .every((row) => row.state?.label === "Not applicable to this line"),
    ).toBe(true);
    expect(
      explanation.resolutionEvidence?.chain.rows.find(
        (row) => row.id === f.purchase.shortcode,
      )?.state?.kind,
    ).toBe("done");
  });

  it("keeps a retained Product reference ineligible for merchant fallback after soft deletion", async () => {
    const f = await categoryContextFixture("food_retail");
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Purchase" SET "spendingCategoryId"=NULL WHERE id=${f.purchase.id}`,
    );
    const live = await explainExpenseCategory(f.line);
    expect(fieldValueOf(live.envelope)).toBe(f.mapped.shortcode);
    expect(
      live.resolutionEvidence?.chain.rows.find(
        (row) => row.title === "Vendor default without a Product",
      )?.state,
    ).toEqual({ kind: "skipped", label: "Not applicable to this line" });
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Product" SET "deletedAt"=CURRENT_TIMESTAMP WHERE id=${f.product.id}`,
    );
    const deleted = await explainExpenseCategory(f.line);
    expect(fieldValueOf(deleted.envelope)).toBeNull();
    expect(deleted.resolutionEvidence?.fallbackSource).toBeNull();
    expect(
      deleted.resolutionEvidence?.chain.rows.find(
        (row) => row.title === "Vendor default without a Product",
      )?.state,
    ).toEqual({ kind: "skipped", label: "Not applicable to this line" });
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Expense" SET "productId"=NULL WHERE id=${f.line.id}`,
    );
    const absent = await explainExpenseCategory(f.line);
    expect(fieldValueOf(absent.envelope)).toBe(f.contextual.shortcode);
    expect(absent.resolutionEvidence?.fallbackSource?.entityId).toBe(
      f.vendor.shortcode,
    );
    expect(
      absent.resolutionEvidence?.chain.rows.find(
        (row) => row.title === "Vendor default without a Product",
      )?.state?.kind,
    ).toBe("done");
  });

  it("explains unresolved receipt roles without inheriting assigned category alternatives", async () => {
    const f = await categoryContextFixture("restaurant");
    const unresolved = await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic unresolved receipt role",
      lineKind: "unclassified",
      date: "2026-09-01",
      cost: 1,
      costType: "materials",
      purchaseId: f.purchase.id,
    });
    const explanation = await explainExpenseCategory(unresolved);
    expect(explanation.envelope.result).toMatchObject({
      kind: "live",
      decision: { outcome: { kind: "empty", reason: "not_applicable" } },
    });
    expect(explanation.resolutionEvidence?.fallbackSource).toBeNull();
    expect(
      explanation.resolutionEvidence?.chain.rows.find(
        (row) => row.id === f.purchase.shortcode,
      ),
    ).toMatchObject({
      trailing: "Synthetic deliberate purpose",
      state: { kind: "skipped", label: "Not applicable to this line" },
    });
    expect(
      explanation.resolutionEvidence?.chain.rows.some(
        (row) => row.state?.kind === "done",
      ),
    ).toBe(false);
  });

  // The feature popover showed no ladder, and its "Edit source" linked back
  // to the category being inspected instead of the ancestor supplying it.
  it("ladders Product Category feature ancestry and targets the supplying ancestor", async () => {
    // Every feature is already bound once by the seeded taxonomy.
    const root = {
      id: taxonomyId("household"),
      shortcode: taxonomyShortcode("household"),
    };
    const middle = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture household middle",
      parentId: root.id,
    });
    const leaf = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture household leaf",
      parentId: middle.id,
    });
    const explain = (shortcode: string) =>
      explainField(context(), {
        entityKind: "productCategory",
        entityId: parseShortcodeFor("productCategory", shortcode),
        field: "feature",
        surface: "list",
      });

    const inherited = await explain(leaf.shortcode);
    expect(inherited.envelope).toMatchObject({
      current: { assignment: { kind: "inherit" } },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "value", value: "household" },
          provenance: {
            kind: "inherited",
            source: { entityId: root.shortcode },
          },
        },
      },
    });
    expect(
      inherited.resolutionEvidence?.chain.rows.map((row) => [
        row.id,
        row.state?.kind,
      ]),
    ).toEqual([
      [null, "skipped"],
      [middle.shortcode, "skipped"],
      [root.shortcode, "done"],
    ]);
    expect(inherited.actions).toEqual([
      expect.objectContaining({
        kind: "editSource",
        target: { entityKind: "productCategory", entityId: root.shortcode },
      }),
    ]);

    const bound = await explain(root.shortcode);
    expect(bound.envelope.current.assignment).toMatchObject({
      kind: "value",
      value: "household",
    });
    expect(bound.resolutionEvidence?.fallbackSource).toBeNull();
    expect(bound.actions[0]?.target.entityId).toBe(root.shortcode);
  });

  it("does not name a cross-Project parent trade as a Task fallback", async () => {
    const first = await insertWithShortcode(ctx.db, "project", {
      name: "Fixture parent project",
      defaultTrade: "building",
    });
    const second = await insertWithShortcode(ctx.db, "project", {
      name: "Fixture independent project",
      defaultTrade: "plumbing",
    });
    const parent = await insertWithShortcode(ctx.db, "task", {
      name: "Fixture parent task",
      projectId: first.id,
      projectMode: "explicit",
      trade: "electrical",
    });
    const child = await insertWithShortcode(ctx.db, "task", {
      name: "Fixture separate task",
      projectId: second.id,
      projectMode: "explicit",
      parentTaskId: parent.id,
      trade: "other",
    });
    const explanation = await explainField(context(), {
      entityKind: "task",
      entityId: parseShortcodeFor("task", child.shortcode),
      field: "trade",
      surface: "list",
    });
    expect(
      explanation.resolutionEvidence?.chain.rows.find(
        (row) => row.id === second.shortcode,
      )?.trailing,
    ).toBe("Plumbing");
    expect(explanation.resolutionEvidence?.fallbackSource).toMatchObject({
      entityKind: "project",
      entityId: second.shortcode,
    });
    expect(explanation.envelope.current.controls).toMatchObject({
      kind: "editable",
      reset: {
        kind: "available",
        preview: {
          kind: "ready",
          result: {
            kind: "live",
            decision: {
              outcome: { kind: "value", value: "plumbing" },
              provenance: {
                kind: "inherited",
                source: { entityKind: "project", entityId: second.shortcode },
              },
            },
          },
        },
      },
    });
  });

  it("explains mixed adjustment shares through each contributing principal", async () => {
    const project = await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic shared project",
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic share supplier",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      orderId: "SYNTHETIC-SHARES",
      vendorId: vendor.id,
      defaultProjectId: project.id,
      defaultTrade: "plumbing",
    });
    const first = await insertWithShortcode(ctx.db, "expense", {
      name: "Fixture first principal",
      purchaseId: purchase.id,
      lineKind: "principal",
      date: "2026-09-01",
      cost: 30,
      trade: "building",
      costType: "materials",
    });
    const second = await insertWithShortcode(ctx.db, "expense", {
      name: "Fixture second principal",
      purchaseId: purchase.id,
      lineKind: "principal",
      date: "2026-09-01",
      cost: 10,
      trade: "plumbing",
      costType: "services",
    });
    const adjustment = await insertWithShortcode(ctx.db, "expense", {
      name: "Fixture shared shipping",
      purchaseId: purchase.id,
      lineKind: "shipping",
      date: "2026-09-01",
      cost: 8,
      costType: "materials",
    });
    const explanation = await explainField(context(), {
      entityKind: "expense",
      entityId: parseShortcodeFor("expense", adjustment.shortcode),
      field: "trade",
      surface: "list",
    });
    expect(explanation.envelope.result).toMatchObject({
      kind: "live",
      decision: { provenance: { kind: "allocated" } },
    });
    expect(explanation.resolutionEvidence?.outcome).toBe("mixed");
    expect(
      explanation.resolutionEvidence?.contributors
        ?.map((block) => block.chain.rows[0]?.id)
        .sort(),
    ).toEqual([first.shortcode, second.shortcode].sort());
    expect(
      explanation.resolutionEvidence?.contributors?.every((block) =>
        block.chain.rows.some((row) => row.state?.kind === "done"),
      ),
    ).toBe(true);
    expect(
      explanation.resolutionEvidence?.contributors
        ?.flatMap((block) => block.chain.rows[0]?.lines ?? [])
        .map((line) => line.text)
        .join(" "),
    ).toContain("positive");
    const projects = await explainField(context(), {
      entityKind: "expense",
      entityId: parseShortcodeFor("expense", adjustment.shortcode),
      field: "projectId",
      surface: "list",
    });
    expect(fieldValueOf(projects.envelope)).toBeNull();
    expect(projects.resolutionEvidence?.outcome).toBe("resolved");
    expect(
      projects.resolutionEvidence?.contributors?.map(
        (block) => block.chain.rows[0]?.trailing,
      ),
    ).toEqual(["Synthetic shared project", "Synthetic shared project"]);

    await updateExpense(ctx.db, first.shortcode, { trade: null }, ctx.actor);
    const refreshed = await explainField(context(), {
      entityKind: "expense",
      entityId: parseShortcodeFor("expense", adjustment.shortcode),
      field: "trade",
      surface: "list",
    });
    expect(fieldValueOf(refreshed.envelope)).toBe("plumbing");
    expect(refreshed.resolutionEvidence?.outcome).toBe("resolved");
    expect(
      await getDb(ctx.db).query.expense.findFirst({
        where: (expense, { eq }) => eq(expense.id, first.id),
        columns: { trade: true },
      }),
    ).toEqual({ trade: null });
  });

  it("keeps a known allocated trade resolved beside an unknown contributor", async () => {
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic partial supplier",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      orderId: "SYNTHETIC-PARTIAL",
      vendorId: vendor.id,
    });
    for (const trade of ["building", null] as const) {
      await insertWithShortcode(ctx.db, "expense", {
        name: "Fixture partial principal",
        purchaseId: purchase.id,
        lineKind: "principal",
        date: "2026-09-01",
        cost: 10,
        trade,
        costType: "materials",
      });
    }
    const adjustment = await insertWithShortcode(ctx.db, "expense", {
      name: "Fixture partial shipping",
      purchaseId: purchase.id,
      lineKind: "shipping",
      date: "2026-09-01",
      cost: 2,
      costType: "materials",
    });
    const explanation = await explainField(context(), {
      entityKind: "expense",
      entityId: parseShortcodeFor("expense", adjustment.shortcode),
      field: "trade",
      surface: "list",
    });
    expect(fieldValueOf(explanation.envelope)).toBe("building");
    expect(explanation.resolutionEvidence?.outcome).toBe("resolved");
    expect(explanation.resolutionEvidence?.contributors).toHaveLength(2);
  });

  it("keeps Recipe yield and Purchase policy fallbacks visible behind overrides", async () => {
    const recipe = await insertWithShortcode(ctx.db, "recipe", {
      name: "Fixture serving override",
      servings: 2,
      yield: { value: 4, unit: "servings" },
    });
    const serving = await explainField(context(), {
      entityKind: "recipe",
      entityId: parseShortcodeFor("recipe", recipe.shortcode),
      field: "servings",
      surface: "list",
    });
    expect(serving.resolutionEvidence?.chain.rows).toEqual([
      expect.objectContaining({
        state: { kind: "done", label: "Used" },
        trailing: "2",
      }),
      expect.objectContaining({
        trailing: "4",
        state: { kind: "skipped", label: "Evaluated · overridden" },
      }),
    ]);
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture policy category",
      itemizationExpectation: "not_expected",
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Fixture policy vendor",
      itemizationExpectation: "required",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      orderId: "SYNTHETIC-POLICY",
      vendorId: vendor.id,
      spendingCategoryId: category.id,
      itemizationExpectation: "unknown",
    });
    const policy = await explainField(context(), {
      entityKind: "purchase",
      entityId: parseShortcodeFor("purchase", purchase.shortcode),
      field: "itemizationExpectation",
      surface: "list",
    });
    expect(policy.resolutionEvidence?.chain.rows.map((row) => row.id)).toEqual([
      null,
      vendor.shortcode,
      category.shortcode,
      null,
    ]);
    expect(policy.resolutionEvidence?.fallbackSource?.entityId).toBe(
      vendor.shortcode,
    );
  });

  it("preserves an inherited nobody decision and excludes Task grandparents", async () => {
    const project = await insertWithShortcode(ctx.db, "project", {
      name: "Fixture assigned project",
      assigneeMode: "explicit",
      assigneeId: null,
    });
    const grandparent = await insertWithShortcode(ctx.db, "task", {
      name: "Fixture unused grandparent",
      trade: "electrical",
    });
    const parent = await insertWithShortcode(ctx.db, "task", {
      name: "Fixture nobody parent",
      parentTaskId: grandparent.id,
      assigneeMode: "explicit",
      assigneeId: null,
    });
    const child = await insertWithShortcode(ctx.db, "task", {
      name: "Fixture inherited child",
      trade: "other",
      parentTaskId: parent.id,
      projectMode: "explicit",
      projectId: project.id,
    });
    const explanation = await explainField(context(), {
      entityKind: "task",
      entityId: parseShortcodeFor("task", child.shortcode),
      field: "assigneeId",
      surface: "list",
    });
    expect(fieldValueOf(explanation.envelope)).toBeNull();
    expect(explanation.resolutionEvidence?.outcome).toBe("resolved");
    expect(explanation.resolutionEvidence?.chain.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: parent.shortcode,
          state: { kind: "done", label: "Used" },
        }),
      ]),
    );
    const trade = await explainField(context(), {
      entityKind: "task",
      entityId: parseShortcodeFor("task", child.shortcode),
      field: "trade",
      surface: "list",
    });
    expect(
      trade.resolutionEvidence?.chain.rows.map((row) => row.id),
    ).not.toContain(grandparent.shortcode);
    expect(fieldValueOf(trade.envelope)).toBe("other");
    expect(trade.resolutionEvidence?.chain.rows[0]?.state?.kind).toBe("done");
  });

  it("shows the full stock tracking fallback behind a Product override", async () => {
    const parent = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture tracking parent",
      stockTracked: false,
    });
    const child = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture tracking child",
      parentId: parent.id,
    });
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Fixture tracking override",
      brandId: await findOrCreateVendor(ctx.db, "Fixture"),
      categoryId: child.id,
      stockTracked: true,
    });
    const explanation = await explainField(context(), {
      entityKind: "product",
      entityId: parseShortcodeFor("product", product.shortcode),
      field: "stockTracked",
      surface: "list",
    });
    expect(
      explanation.resolutionEvidence?.chain.rows.map((row) => row.id),
    ).toEqual([null, child.shortcode, parent.shortcode]);
    expect(explanation.resolutionEvidence?.fallbackSource?.entityId).toBe(
      parent.shortcode,
    );
    expect(explanation.resolutionEvidence?.chain.rows[2]?.trailing).toBe("No");
  });

  it("explains manual price precedence and links the records behind an expense count", async () => {
    const product = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Explanation product", price: 20 }),
      ctx.actor,
    );
    const expense = await createExpense(
      ctx.db,
      makeExpenseInput({ productId: product.id, cost: 12, productQuantity: 2 }),
      ctx.actor,
    );
    await drainStoredDerived(ctx.db);
    const requestContext = context();
    const record = await executeEntity(requestContext, {
      action: "get",
      entity: "product",
      id: product.id,
      missing: "error",
    });
    if (record.action !== "get" || !record.item)
      throw new Error("Expected product detail");
    const pricing = await loadProductPricing(ctx.db, [
      { id: product.entityId, price: 20 },
    ]);
    expect(pricing.get(product.entityId)).toMatchObject({
      effectivePrice: 20,
      derivedPrice: 6,
    });
    expect(fieldValueOf(record.item.fields.price)).toBe(20);
    expect(record.item).not.toHaveProperty("pricing.effectivePrice");
    expect(record.item).not.toHaveProperty("pricing.derivedPrice");

    const price = await explainField(requestContext, {
      entityKind: "product",
      entityId: product.id,
      field: "price",
      surface: "detail",
    });
    expect(fieldValueOf(price.envelope)).toBe(20);
    expect(price.envelope).toMatchObject({
      current: {
        assignment: { kind: "value", value: 20 },
        controls: { kind: "editable", reset: { kind: "available" } },
      },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "value", value: 20 },
          provenance: { kind: "own" },
        },
      },
    });
    expect(price.sources).toEqual([]);
    expect(price.resolutionEvidence?.contributors?.[0]?.chain.rows[0]?.id).toBe(
      expense.output.id,
    );
    expect(price.resolutionEvidence?.chain.rows).toEqual([
      expect.objectContaining({
        trailing: "20",
        state: { kind: "done", label: "Used" },
      }),
      expect.objectContaining({
        trailing: "6",
        state: { kind: "skipped", label: "Evaluated · overridden" },
      }),
    ]);

    const unitPrice = await explainField(requestContext, {
      entityKind: "product",
      entityId: product.id,
      field: "unitPrice",
      surface: "detail",
    });
    expect(fieldValueOf(unitPrice.envelope)).toBe("$20.00/ea");
    expect(unitPrice.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Complete unit conversion graph",
          value: expect.arrayContaining([
            expect.objectContaining({
              a: { value: 1, unit: "each" },
              b: { value: 20, unit: "dollar" },
            }),
          ]),
        }),
      ]),
    );

    const count = await explainField(requestContext, {
      entityKind: "product",
      entityId: product.id,
      field: "expenseCount",
      surface: "list",
    });
    expect(fieldValueOf(count.envelope)).toBe(1);
    expect(count.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: { entityKind: "expense", entityId: expense.output.id },
        }),
      ]),
    );
  });

  it("uses the same explicit owner and evidence fingerprint as inventory detail", async () => {
    const product = await createProductIdentityFixture(
      ctx.db,
      makeProductInput(),
      ctx.actor,
    );
    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput(),
      ctx.actor,
    );
    const owner = await createLedgerParty(
      ctx.db,
      { name: "Test owner", kind: "member", notes: null },
      ctx.actor,
    );
    const entry = await createInventoryEntry(
      ctx.db,
      {
        productId: product.entityId,
        locationId: location.entityId,
        amount: { value: 1, unit: "each" },
        ownershipMode: "explicit",
        ownerLedgerPartyId: owner.entityId,
      },
      ctx.actor,
    );
    const requestContext = context();
    const record = await executeEntity(requestContext, {
      action: "get",
      entity: "inventory",
      id: entry.id,
      missing: "error",
    });
    if (record.action !== "get") throw new Error("Expected inventory detail");
    const explanation = await explainField(requestContext, {
      entityKind: "inventory",
      entityId: entry.id,
      field: "ownerLedgerPartyId",
      surface: "detail",
    });
    expect(record.item).toMatchObject({
      fields: {
        ownerLedgerPartyId: {
          current: { assignment: { kind: "value", value: owner.output.id } },
        },
      },
    });
    expect(explanation.envelope).toMatchObject({
      current: { assignment: { kind: "value", value: owner.output.id } },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "value", value: owner.output.id },
          provenance: { kind: "own" },
        },
      },
    });
    expect(explanation.resolutionEvidence?.chain.rows[0]).toMatchObject({
      title: expect.stringMatching(/^This /),
      trailing: "Test owner",
      state: { kind: "done" },
    });
  });

  it("keeps aggregate values complete while bounding their record evidence", async () => {
    const product = await createProductIdentityFixture(
      ctx.db,
      makeProductInput(),
      ctx.actor,
    );
    for (let index = 0; index < 31; index += 1) {
      await insertWithShortcode(ctx.db, "expense", {
        lineKind: "principal",
        name: `Count evidence ${index}`,
        productId: product.entityId,
        cost: 1,
        costType: "materials",
        trade: "other",
        date: "2024-01-15",
      });
    }
    const result = await explainField(context(), {
      entityKind: "product",
      entityId: product.id,
      field: "expenseCount",
      surface: "list",
    });
    const linkedExpenses = result.sources.filter(
      (source) => source.entity?.entityKind === "expense",
    );
    expect(fieldValueOf(result.envelope)).toBe(31);
    expect(linkedExpenses.length).toBeGreaterThan(0);
    expect(linkedExpenses.length).toBeLessThan(31);
    expect(result.truncated).toBe(true);
  });

  it("shows a reimbursement's stored policy as overridden rather than unset", async () => {
    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Synthetic reimbursement account",
      identity: { kind: "cash" },
    });
    const transaction = await insertWithShortcode(
      ctx.db,
      "financialTransaction",
      {
        accountId: account.id,
        amount: -10,
        kind: "income",
        status: "posted",
        postedDate: "2026-09-01",
        itemizationExpectation: "required",
      },
    );
    await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic reimbursed booking",
      lineKind: "principal",
      cost: -10,
      date: "2026-09-01",
      costType: "materials",
      trade: "other",
      economicRole: "reimbursement",
      lineBasis: "allocation",
      bookingTransactionCode: transaction.shortcode,
    });
    const explanation = await explainField(context(), {
      entityKind: "financialTransaction",
      entityId: parseShortcodeFor(
        "financialTransaction",
        transaction.shortcode,
      ),
      field: "itemizationExpectation",
      surface: "list",
    });
    expect(explanation.envelope).toMatchObject({
      current: {
        assignment: { kind: "value", value: "required" },
        controls: { kind: "readonly", reason: "allocated" },
      },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "value", value: "not_expected" },
          provenance: { kind: "allocated" },
        },
      },
    });
    expect(explanation.resolutionEvidence?.chain.rows[1]).toMatchObject({
      trailing: "Expected",
      state: { kind: "skipped", label: "Evaluated · overridden" },
    });
  });

  it("explains full linked policies behind transaction overrides and reviewed reimbursement", async () => {
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic transaction policy category",
      itemizationExpectation: "not_expected",
    });
    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Synthetic linked policy account",
      identity: { kind: "cash" },
    });
    const transaction = await insertWithShortcode(
      ctx.db,
      "financialTransaction",
      {
        accountId: account.id,
        amount: 2,
        kind: "purchase",
        status: "posted",
        postedDate: "2026-09-01",
        spendingCategoryId: category.id,
      },
    );
    const explain = () =>
      explainField(context(), {
        entityKind: "financialTransaction",
        entityId: parseShortcodeFor(
          "financialTransaction",
          transaction.shortcode,
        ),
        field: "itemizationExpectation",
        surface: "list",
      });
    const unlinked = await explain();
    expect(fieldValueOf(unlinked.envelope)).toBe("not_expected");
    expect(
      unlinked.resolutionEvidence?.chain.rows.find(
        (row) => row.title === "Linked Purchase policies",
      ),
    ).toMatchObject({ id: null, state: { kind: "skipped", label: "Not set" } });
    const supplier = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic linked policy vendor",
    });
    const purchaseRecord = await createRepoEntity(ctx, "purchase", {
      vendorId: supplier.output.id,
      orderId: "SYNTHETIC-LINKED-REQUIRED",
      itemizationExpectation: "required",
    });
    const purchase = {
      id: purchaseRecord.entityId,
      shortcode: purchaseRecord.output.id,
    };
    await getDb(ctx.db).insert(financialTransactionAllocation).values({
      transactionId: transaction.id,
      purchaseId: purchase.id,
      amount: 1,
    });
    const single = await explain();
    expect(single.envelope.result).toMatchObject({
      kind: "live",
      decision: {
        outcome: { kind: "value", value: "required" },
        provenance: {
          kind: "inherited",
          source: { entityId: purchase.shortcode },
        },
      },
    });
    expect(
      single.resolutionEvidence?.chain.rows.find(
        (row) => row.title === "Linked Purchase policies",
      ),
    ).toMatchObject({
      id: purchase.shortcode,
      trailing: "Expected",
      state: { kind: "done" },
    });
    const secondRecord = await createRepoEntity(ctx, "purchase", {
      vendorId: supplier.output.id,
      orderId: "SYNTHETIC-LINKED-UNKNOWN",
      itemizationExpectation: "unknown",
    });
    const second = {
      id: secondRecord.entityId,
      shortcode: secondRecord.output.id,
    };
    await getDb(ctx.db).insert(financialTransactionAllocation).values({
      transactionId: transaction.id,
      purchaseId: second.id,
      amount: 1,
    });
    const multiple = await explain();
    expect(multiple.envelope.result).toMatchObject({
      kind: "live",
      decision: {
        outcome: { kind: "value", value: "required" },
        provenance: { kind: "default", source: null },
      },
    });
    expect(
      multiple.resolutionEvidence?.chain.rows.find(
        (row) => row.title === "Linked Purchase policies",
      ),
    ).toMatchObject({
      id: null,
      trailing: "Expected",
      state: { kind: "done" },
    });
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "FinancialTransaction" SET "itemizationExpectation"=${itemizationExpectation.enum.unknown} WHERE id=${transaction.id}`,
    );
    const overridden = await explain();
    expect(overridden.envelope).toMatchObject({
      current: { assignment: { kind: "value", value: "unknown" } },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "value", value: "unknown" },
          provenance: { kind: "own" },
        },
      },
    });
    expect(
      overridden.resolutionEvidence?.chain.rows.find(
        (row) => row.title === "Linked Purchase policies",
      ),
    ).toMatchObject({
      id: null,
      trailing: "Expected",
      state: { kind: "skipped", label: "Evaluated · overridden" },
    });
    await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic linked policy reimbursement",
      lineKind: "principal",
      cost: -2,
      date: "2026-09-01",
      costType: "materials",
      economicRole: "reimbursement",
      lineBasis: "allocation",
      bookingTransactionCode: transaction.shortcode,
    });
    const reimbursed = await explain();
    expect(reimbursed.envelope).toMatchObject({
      current: { controls: { kind: "readonly", reason: "allocated" } },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "value", value: "not_expected" },
          provenance: { kind: "allocated" },
        },
      },
    });
    expect(
      reimbursed.resolutionEvidence?.chain.rows.find(
        (row) => row.title === "Linked Purchase policies",
      ),
    ).toMatchObject({
      id: null,
      trailing: "Expected",
      state: { kind: "skipped", label: "Evaluated · overridden" },
    });
  });

  it("keeps the full linked policy aggregate when contributor evidence is bounded", async () => {
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic policy supplier",
    });
    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Synthetic policy account",
      identity: { kind: "cash" },
    });
    const transaction = await insertWithShortcode(
      ctx.db,
      "financialTransaction",
      {
        accountId: account.id,
        amount: 21,
        kind: "purchase",
        status: "posted",
        postedDate: "2026-09-01",
      },
    );
    for (let index = 0; index < 21; index++) {
      const purchase = await insertWithShortcode(ctx.db, "purchase", {
        orderId: `SYNTHETIC-POLICY-${index}`,
        vendorId: vendor.id,
        itemizationExpectation: index === 20 ? "required" : "not_expected",
      });
      await getDb(ctx.db).insert(financialTransactionAllocation).values({
        transactionId: transaction.id,
        purchaseId: purchase.id,
        amount: 1,
      });
    }
    const explanation = await explainField(context(), {
      entityKind: "financialTransaction",
      entityId: parseShortcodeFor(
        "financialTransaction",
        transaction.shortcode,
      ),
      field: "itemizationExpectation",
      surface: "list",
    });
    expect(fieldValueOf(explanation.envelope)).toBe("required");
    expect(explanation.resolutionEvidence?.outcome).toBe("resolved");
    expect(explanation.resolutionEvidence?.contributors).toHaveLength(20);
    expect(explanation.truncated).toBe(true);
    expect(
      explanation.resolutionEvidence?.chain.rows.find(
        (row) => row.state?.kind === "done",
      ),
    ).toMatchObject({
      title: "Linked Purchase policies",
      trailing: "Expected",
    });
  });

  it("explains an explicit expense trade override as a typed resolution, not the declared source trio", async () => {
    const expense = await createExpense(
      ctx.db,
      makeExpenseInput({ trade: "electrical" }),
      ctx.actor,
    );
    const explanation = await explainField(context(), {
      entityKind: "expense",
      entityId: expense.output.id,
      field: "trade",
      surface: "detail",
    });
    expect(explanation.envelope).toMatchObject({
      current: { assignment: { kind: "value", value: "electrical" } },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "value", value: "electrical" },
          provenance: { kind: "own" },
        },
      },
    });
    expect(explanation.sources).toEqual([]);
  });

  it("explains an inherited project default trade as a typed resolution with its source project linked", async () => {
    const parent = await insertWithShortcode(ctx.db, "project", {
      name: "Explanation parent project",
      defaultTrade: "building",
    });
    const child = await insertWithShortcode(ctx.db, "project", {
      name: "Explanation child project",
      parentProjectId: parent.id,
      defaultTrade: null,
    });
    const explanation = await explainField(context(), {
      entityKind: "project",
      entityId: child.shortcode,
      field: "defaultTrade",
      surface: "detail",
    });
    expect(explanation.envelope).toMatchObject({
      current: { assignment: { kind: "inherit" } },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "value", value: "building" },
          provenance: {
            kind: "inherited",
            source: { entityKind: "project", entityId: parent.shortcode },
          },
        },
      },
    });
    expect(explanation.sources).toEqual([]);
  });
});
