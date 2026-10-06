import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import { recordStatementRowsInput } from "@cubby/schemas/statement-row";
import { and, eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { entityIdentity } from "~/server/db/entity-identity-schema";
import { entityExternalId } from "~/server/db/schema";
/**
 * `EntityExternalId` (one table for every outside identifier). Failure modes
 * pinned here, each a regression a money or identity path would carry:
 *
 * - a settlement reference whose transaction was deleted cannot be recorded
 *   again (the deleted transaction's rows still hold the live unique);
 * - a transaction carrying several references loses some, or trips a
 *   per-entity primary slot that settlement references do not have;
 * - Purchase settlement status or the `settlement_reference` gap reads the
 *   wrong evidence once references leave the transaction row;
 * - two products claim the same identity identifier without a structured
 *   refusal;
 * - re-importing a statement export writes anything;
 * - re-importing a Notion recipe page mints a second recipe.
 */
import { deleteThroughKernel } from "~/server/testing/entity-kernel";

import { loadDataQualities } from "./data-quality/hydrate";
import { getDb } from "./database-helpers";
import { updateFinancialTransaction } from "./financial-transaction";
import { updateProduct } from "./product/crud";
import {
  externalIdKey,
  findProductsByExternalIds,
} from "./product/find-by-external-ids";
import { getPurchaseByID } from "./purchase";
import { getNotionRecipePageIds, upsertNotionRecipe } from "./recipe/crud";
import {
  createProductFixture as createProduct,
  makeProductInput,
  makeRecipeInput,
} from "./repo.fixtures";
import { resolveOrThrow } from "./shortcode-resolver";
import { recordStatementRows } from "./statement-row";
import { findOrCreateVendor, getVendorByID } from "./vendor";

describe("EntityExternalId", () => {
  const ctx = withTestDb();

  it("batches exact identifiers without conflating kinds or hiding conflicting products", async () => {
    const first = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Synthetic first",
        externalIds: [
          { source: "sample-store", kind: "asin", externalId: "shared-code" },
        ],
      }),
      ctx.actor,
    );
    const second = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Synthetic second",
        externalIds: [
          {
            source: "sample-store",
            kind: "retailer_sku",
            externalId: "shared-code",
          },
        ],
      }),
      ctx.actor,
    );
    const asin = {
      source: "sample-store",
      kind: "asin" as const,
      externalId: "shared-code",
    };
    const sku = { ...asin, kind: "retailer_sku" as const };
    const anyKind = { source: asin.source, externalId: asin.externalId };
    const hits = await findProductsByExternalIds(ctx.db, [
      asin,
      sku,
      anyKind,
      asin,
    ]);
    expect(hits.get(externalIdKey(asin))?.map((hit) => hit.shortcode)).toEqual([
      first.id,
    ]);
    expect(hits.get(externalIdKey(sku))?.map((hit) => hit.shortcode)).toEqual([
      second.id,
    ]);
    expect(
      hits
        .get(externalIdKey(anyKind))
        ?.map((hit) => hit.shortcode)
        .sort(),
    ).toEqual([first.id, second.id].sort());
  });

  const mkAccount = async (name: string) =>
    (
      await createRepoEntity(ctx, "financialAccount", {
        name,
        identity: { kind: "credit_card", issuer: null, network: "visa" },
        cardNumbers: [],
        sourceAliases: [],
      })
    ).output;

  const mkTransaction = async (
    accountId: string,
    sourceRefs: { source: string; externalId: string }[],
    extra: Partial<z.input<typeof financialTransactionCreateInput>> = {},
  ) =>
    (
      await createRepoEntity(ctx, "financialTransaction", {
        accountId,
        kind: "purchase",
        status: "pending",
        amount: 12.5,
        sourceRefs,
        ...extra,
      })
    ).output;

  // By shortcode through Entity: a deleted transaction no longer resolves.
  const refRows = (transactionShortcode: string) =>
    getDb(ctx.db)
      .select({
        source: entityExternalId.source,
        externalId: entityExternalId.externalId,
        isPrimary: entityExternalId.isPrimary,
        deletedAt: entityExternalId.deletedAt,
      })
      .from(entityExternalId)
      .innerJoin(
        entityIdentity,
        eq(entityIdentity.id, entityExternalId.entityId),
      )
      .where(eq(entityIdentity.shortcode, transactionShortcode))
      .orderBy(entityExternalId.source, entityExternalId.externalId);

  it("re-records a settlement reference after its transaction is deleted", async () => {
    const account = await mkAccount("Delete Visa");
    const ref = { source: "monarch", externalId: "mon-deleted-1" };
    const first = await mkTransaction(account.id, [ref]);
    await deleteThroughKernel(ctx.db, ctx.actor, "financialTransaction", [
      first.id,
    ]);
    // The deleted transaction's reference went with it...
    expect(await refRows(first.id)).toEqual([
      expect.objectContaining({ ...ref, deletedAt: expect.any(Date) }),
    ]);
    // ...so the same bank line can be recorded again.
    const second = await mkTransaction(account.id, [ref]);
    expect(second.sourceRefs).toEqual([ref]);
  });

  it("keeps every reference of a multi-reference transaction, none primary", async () => {
    const account = await mkAccount("Multi Visa");
    const refs = [
      { source: "copilot", externalId: "cop-1" },
      { source: "monarch", externalId: "mon-1" },
      { source: "monarch", externalId: "mon-2" },
    ];
    const transaction = await mkTransaction(account.id, refs);
    expect(transaction.sourceRefs).toEqual(refs);
    expect((await refRows(transaction.id)).map((row) => row.isPrimary)).toEqual(
      [null, null, null],
    );

    const updated = await updateFinancialTransaction(
      ctx.db,
      transaction.id,
      { sourceRefs: [refs[0]!, refs[2]!] },
      ctx.actor,
    );
    expect(updated.output.sourceRefs).toEqual([refs[0], refs[2]]);
    const rows = await refRows(transaction.id);
    expect(rows.filter((row) => row.deletedAt === null)).toHaveLength(2);
    expect(rows.filter((row) => row.deletedAt !== null)).toEqual([
      expect.objectContaining(refs[1]),
    ]);
  });

  it("refuses a reference another live transaction holds, with the structured reason", async () => {
    const account = await mkAccount("Conflict Visa");
    const ref = { source: "monarch", externalId: "mon-held" };
    await mkTransaction(account.id, [ref]);
    await expect(mkTransaction(account.id, [ref])).rejects.toMatchObject({
      reason: "FINANCIAL_TRANSACTION_SOURCE_REF_CONFLICT",
    });
  });

  it("settles a purchase by reference exactly as before and reopens the gap when the reference goes", async () => {
    const account = await mkAccount("Settlement Visa");
    const vendorId = await findOrCreateVendor(ctx.db, "Settlement Vendor");
    const purchase = (
      await createRepoEntity(ctx, "purchase", {
        date: "2026-03-02",
        vendorId: (await getVendorByID(ctx.db, vendorId)).id,
        orderId: "settle-by-ref-1",
      })
    ).output;
    await createRepoEntity(ctx, "expense", {
      name: "Settled line",
      date: "2026-03-02",
      trade: "other",
      costType: "materials",
      cost: 40,
      purchaseId: purchase.id,
      future: false,
    });
    const transaction = await mkTransaction(
      account.id,
      [{ source: "monarch", externalId: "mon-settle-1" }],
      {
        purchaseId: purchase.id,
        amount: 40,
        status: "posted",
        postedDate: "2026-03-03",
      },
    );
    const purchaseId = await resolveOrThrow(ctx.db, "purchase", purchase.id);
    const gaps = async () =>
      (await loadDataQualities(ctx.db, "purchase", [purchaseId]))
        .get(purchaseId)
        ?.gaps.map((gap) => gap.check) ?? [];

    const settled = await getPurchaseByID(ctx.db, purchaseId);
    expect(settled.financialReconciliation?.status).toBe("match");
    expect(await gaps()).not.toContain("settlement_reference");

    await updateFinancialTransaction(
      ctx.db,
      transaction.id,
      { sourceRefs: [] },
      ctx.actor,
    );
    const unreferenced = await getPurchaseByID(ctx.db, purchaseId);
    expect(unreferenced.financialReconciliation?.status).toBe("match");
    expect(await gaps()).toContain("settlement_reference");
  });

  it("refuses one ASIN on two live products with a structured error", async () => {
    const asin = {
      source: "amazon",
      kind: "asin" as const,
      externalId: "B0SYNTH001",
      url: null,
    };
    await createProduct(
      ctx.db,
      makeProductInput({ name: "Holder Widget", externalIds: [asin] }),
      ctx.actor,
    );
    const other = await createProduct(
      ctx.db,
      makeProductInput({ name: "Other Widget" }),
      ctx.actor,
    );
    await expect(
      updateProduct(ctx.db, other.entityId, { externalIds: [asin] }, ctx.actor),
    ).rejects.toMatchObject({ reason: "PRODUCT_ALREADY_EXISTS" });
  });

  it("treats a statement re-import as a no-op", async () => {
    const input = recordStatementRowsInput.parse({
      import: {
        source: "monarch",
        label: "monarch-2026-03.csv",
        fingerprint: "fp-reimport-1",
        dateKind: "transaction",
        rowCountDeclared: 1,
        notes: null,
      },
      rows: [
        {
          rowPosition: 1,
          accountDescriptor: "Synthetic Card (...0001)",
          statementDate: "2026-03-04",
          providerAmount: -19.99,
          merchant: "Synthetic Hardware",
          rawDescription: "SYNTHETIC HARDWARE 0001",
          sourceCategory: "Home",
          providerStatus: "posted",
          providerNotes: null,
        },
      ],
      dryRun: false,
    });
    await expect(
      recordStatementRows(ctx.db, input, ctx.actor),
    ).resolves.toMatchObject({ inserted: 1 });
    await expect(
      recordStatementRows(ctx.db, input, ctx.actor),
    ).resolves.toMatchObject({ inserted: 0 });
  });

  it("re-imports a Notion recipe page into the same recipe", async () => {
    const pageId = "0f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";
    const first = await upsertNotionRecipe(
      makeRecipeInput({ name: "Synthetic Notion Soup" }),
      pageId,
      ctx.db,
      ctx.actor,
    );
    const renamed = await upsertNotionRecipe(
      makeRecipeInput({ name: "Synthetic Notion Soup, renamed" }),
      pageId,
      ctx.db,
      ctx.actor,
    );
    expect(renamed.id).toBe(first.id);
    expect(await getNotionRecipePageIds(ctx.db)).toEqual([pageId]);
    const rows = await getDb(ctx.db)
      .select({ entityId: entityExternalId.entityId })
      .from(entityExternalId)
      .where(
        and(
          eq(entityExternalId.source, "notion"),
          eq(entityExternalId.externalId, pageId),
        ),
      );
    expect(rows).toEqual([{ entityId: first.id }]);
  });
});
