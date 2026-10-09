import { externalIdInputs } from "@cubby/schemas/external-id";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { acceptedResearchFact } from "@cubby/schemas/research";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import {
  taxonomyId,
  taxonomyShortcode,
} from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  product,
  externalSource,
  runEvidence,
  runFactEvidence,
  runTarget,
} from "~/server/db/schema";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { explainField } from "~/server/operations/field-explanation.server";
import { recordAcceptedFactEvidence } from "~/server/purchase-import/fact-verification";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import { createExpense } from "~/server/repo/expense/crud";
import { createInventoryEntry } from "~/server/repo/inventory/crud";
import { createLedgerParty } from "~/server/repo/ledger-party";
import { resolveProductIdentifierSource } from "~/server/repo/product-identifier-source";
import {
  createLocationFixture,
  createProductFixture,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { createTestRequestContext } from "~/server/testing/request-context";

describe("derived field explanations against canonical records", () => {
  const ctx = withTestDb();

  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );

  it("links registered identifier source owners and preserves unowned slugs", async () => {
    const supplier = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic evidence supplier",
      website: "https://shop.example.test",
    });
    const source = await resolveProductIdentifierSource(ctx.db, {
      url: "https://shop.example.test/catalog/item",
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
    const unownedSource = `vendor-${supplier.entityId}`;
    await getDb(ctx.db).insert(externalSource).values({
      slug: unownedSource,
      label: "Synthetic unowned source",
      vendorId: null,
    });
    const item = await createProductFixture(
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

  it("shows retained verification for an existing model, exposes retired rationale as a proof gap, and hides stale values", async () => {
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Example verified product",
        manufacturer: "Example Works",
        model: "Q-17",
      }),
      ctx.actor,
    );
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Example verification member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const run = await insertWithShortcode(ctx.db, "run", {
      purpose: "product_enrichment",
      trigger: "manual",
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      actorName: "Example verification member",
      actorEmail: "verification@example.test",
      actorLedgerPartyShortcode: party.shortcode,
    });
    const [target] = await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: run.id,
        entityId: item.entityId,
        entityKind: "product",
        targetFingerprint: "example-model-target",
      })
      .returning();
    if (!target) throw new Error("Expected verification target");
    const [evidence] = await getDb(ctx.db)
      .insert(runEvidence)
      .values({
        runId: run.id,
        targetId: target.id,
        kind: "browser_capture",
        objectKey: `synthetic-field-explanation/${crypto.randomUUID()}`,
        checksum: "a".repeat(64),
        mediaType: "text/html",
        sourceMetadata: {
          url: "https://shop.example.test/q17",
          title: "Example product specifications",
        },
      })
      .returning();
    if (!evidence) throw new Error("Expected verification evidence");
    await withTransaction(ctx.db, (tx) =>
      recordAcceptedFactEvidence(tx, {
        runId: run.id,
        targetId: target.id,
        claims: [
          acceptedResearchFact.parse({
            evidenceId: evidence.id,
            fieldPath: "model",
            value: "Q-17",
            support: {
              observation: "Model Q-17, small",
              reasoning:
                "The source identifies the ordered small Q-17 variant.",
            },
          }),
        ],
      }),
    );
    const explain = () =>
      explainField(context(), {
        entityKind: "product",
        entityId: item.id,
        field: "model",
        surface: "detail",
      });
    const matching = await explain();
    expect(matching.verifications).toMatchObject([
      {
        run: { entityKind: "run", entityId: run.shortcode },
        subject: { entityKind: "product", entityId: item.id },
        fieldPath: "model",
        value: "Q-17",
        support: {
          observation: "Model Q-17, small",
          reasoning: "The source identifies the ordered small Q-17 variant.",
        },
        source: { url: "https://shop.example.test/q17" },
      },
    ]);
    const retiredAt = new Date("2026-10-07T17:00:00.000Z");
    await getDb(ctx.db)
      .update(runFactEvidence)
      .set({ support: null, supportRetiredAt: retiredAt })
      .where(eq(runFactEvidence.targetId, target.id));
    const retired = await explain();
    expect(retired.verifications).toMatchObject([
      {
        value: "Q-17",
        support: null,
        supportRetiredAt: retiredAt.toISOString(),
        source: { url: "https://shop.example.test/q17" },
      },
    ]);
    expect(retired.interpretation?.caveats.join(" ")).toMatch(
      /rationale.*retired.*fresh verification/i,
    );
    await getDb(ctx.db)
      .update(product)
      .set({ model: "Q-18" })
      .where(eq(product.id, item.entityId));
    expect((await explain()).verifications).toEqual([]);
  });

  // Lazy explanations must expose the same winning ancestor and fallback as
  // canonical reads, even when an Expense override hides that mapping.
  it("explains Product Category ancestry behind an Expense override", async () => {
    const mapped = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture tools",
    });
    const explicit = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture gifts",
    });
    const parent = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture tools",
      spendingCategoryMode: "mapped",
      spendingCategoryId: mapped.id,
    });
    const child = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture tool storage",
      parentId: parent.id,
    });
    const item = await insertWithShortcode(ctx.db, "product", {
      name: "Fixture toolbox",
      manufacturer: "Fixture",
      categoryId: child.id,
    });
    const line = await insertWithShortcode(ctx.db, "expense", {
      name: "Fixture gift",
      cost: 15,
      date: "2026-09-01",
      productId: item.id,
      spendingCategoryId: explicit.id,
      costType: "tools",
      trade: "other",
    });
    const explanation = await explainField(context(), {
      entityKind: "expense",
      entityId: parseShortcodeFor("expense", line.shortcode),
      field: "spendingCategoryId",
      surface: "list",
    });
    expect(explanation.resolution?.value).toBe(explicit.shortcode);
    expect(explanation.resolution?.fallbackValue).toBe(mapped.shortcode);
    expect(explanation.resolutionEvidence).toMatchObject({
      hierarchy: [
        {
          entity: { entityKind: "productCategory", entityId: child.shortcode },
        },
        {
          entity: { entityKind: "productCategory", entityId: parent.shortcode },
        },
      ],
      fallbackSource: {
        entityKind: "productCategory",
        entityId: parent.shortcode,
      },
    });
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
    expect(inherited.resolution).toMatchObject({
      mode: "inherit",
      value: "household",
      sourceEntity: { entityId: root.shortcode },
    });
    expect(
      inherited.resolutionEvidence?.hierarchy.map((node) => [
        node.entity?.entityId,
        node.value,
      ]),
    ).toEqual([
      [leaf.shortcode, expect.objectContaining({ assigned: false })],
      [middle.shortcode, expect.objectContaining({ assigned: false })],
      [
        root.shortcode,
        expect.objectContaining({ value: "household", assigned: true }),
      ],
    ]);
    expect(inherited.actions).toEqual([
      expect.objectContaining({
        kind: "editSource",
        target: { entityKind: "productCategory", entityId: root.shortcode },
      }),
    ]);

    const bound = await explain(root.shortcode);
    expect(bound.resolution).toMatchObject({
      mode: "explicit",
      fallbackValue: null,
    });
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
    expect(explanation.resolution?.fallbackValue).toBe("plumbing");
    expect(explanation.resolutionEvidence?.fallbackSource).toMatchObject({
      entityKind: "project",
      entityId: second.shortcode,
    });
  });

  it("explains manual price precedence and links the records behind an expense count", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Explanation product", price: 20 }),
      ctx.actor,
    );
    const expense = await createExpense(
      ctx.db,
      makeExpenseInput({ productId: product.id, cost: 12, productQuantity: 2 }),
      ctx.actor,
    );
    const requestContext = context();
    const record = await executeEntity(requestContext, {
      action: "get",
      entity: "product",
      id: product.id,
      missing: "error",
    });
    if (record.action !== "get") throw new Error("Expected product detail");
    expect(record.item).toMatchObject({
      pricing: { effectivePrice: 20, derivedPrice: 6 },
    });

    const price = await explainField(requestContext, {
      entityKind: "product",
      entityId: product.id,
      field: "price",
      surface: "detail",
    });
    expect(price.value).toBe(20);
    expect(price.resolution).toMatchObject({
      mode: "explicit",
      storedValue: 20,
      value: 20,
      fallbackValue: 6,
      sourceEntity: null,
      canReset: true,
    });
    expect(price.sources).toEqual([]);

    const count = await explainField(requestContext, {
      entityKind: "product",
      entityId: product.id,
      field: "expenseCount",
      surface: "list",
    });
    expect(count.value).toBe(1);
    expect(count.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: { entityKind: "expense", entityId: expense.output.id },
        }),
      ]),
    );
  });

  it("uses the same explicit owner and evidence fingerprint as inventory detail", async () => {
    const product = await createProductFixture(
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
        ownershipMode: "person",
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
      field: "effectiveOwnership",
      surface: "detail",
    });
    expect(record.item).toMatchObject({
      effectiveOwnership: explanation.value,
    });
    expect(explanation.value).toMatchObject({
      mode: "person",
      effectiveOwner: { id: owner.output.id },
    });
    expect(explanation.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Stored ownership",
          value: {
            mode: "person",
            owner: { id: owner.output.id, name: "Test owner", kind: "member" },
          },
        }),
      ]),
    );
    expect(explanation.evidenceFingerprint).toBeTypeOf("string");
  });

  it("keeps aggregate values complete while bounding their record evidence", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput(),
      ctx.actor,
    );
    for (let index = 0; index < 31; index += 1) {
      await insertWithShortcode(ctx.db, "expense", {
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
    expect(result.value).toBe(31);
    expect(linkedExpenses.length).toBeGreaterThan(0);
    expect(linkedExpenses.length).toBeLessThan(31);
    expect(result.truncated).toBe(true);
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
    expect(explanation.resolution).toMatchObject({
      mode: "explicit",
      storedValue: "electrical",
      value: "electrical",
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
    expect(explanation.resolution).toMatchObject({
      mode: "inherit",
      storedValue: null,
      value: "building",
      sourceEntity: { entityKind: "project", entityId: parent.shortcode },
    });
    expect(explanation.sources).toEqual([]);
  });
});
