import { parseEntityId } from "@cubby/schemas/identifiers";
import type { ImportWriterInput } from "@cubby/schemas/purchase-import";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  expense,
  importSourceClaim,
  importSourceOrder,
  purchasePaymentEvidence,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { preparePurchaseImport } from "./import-orders";
import { startOrResumeRun } from "./run-service";
import { readImportSourceClaimFamily } from "./source-claim-family";
import { importVendorOrder } from "./writer";

// A canonical source must replay its historical associations before any write;
// aliases cannot be new writable identities, duplicate family order keys cannot
// select an arbitrary owner, and refreshing one order cannot duplicate payment
// sets or change a sibling's accepted checksum/history. Preparation must fence
// against the same retained association regardless of canonicalization.
describe("canonical source claim families", () => {
  const ctx = withTestDb();
  const canonicalKey = "browser:example-account:consolidated";

  async function world() {
    const db = getDb(ctx.db);
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Example source-family member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example family seller",
      website: "https://shop.example.test",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Example family account",
      ledgerPartyId: party.id,
      vendorId: vendor.id,
    });
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    function input(
      orderId: string,
      externalKey: string,
      amount: number,
      checksum = "a".repeat(64),
    ): ImportWriterInput {
      return {
        runId: run.id,
        ledgerPartyId: party.id,
        vendorId: vendor.id,
        vendorAccountId: account.id,
        defaultTrade: "other",
        source: { kind: "browser_order", externalKey, checksum },
        extraction: {
          status: "ready",
          candidate: {
            orderId,
            orderedAt: "2026-09-01T12:00:00.000Z",
            merchant: "Example family seller",
            currency: "USD",
            printedGrandTotal: amount,
            lines: [{ title: "Shipping", amount, lineKind: "shipping" }],
            payments: [
              {
                amount,
                chargedAt: "2026-09-02T12:00:00.000Z",
                cardLastFour: "1234",
                description: "Example retained payment",
              },
            ],
            allShipmentsDelivered: false,
          },
        },
        primaryDocumentImageId: null,
        screenshotImageId: null,
        productResolutions: [],
      };
    }
    const first = input("EXAMPLE-101", "legacy:order-101", 20);
    const second = input("EXAMPLE-102", "legacy:order-102", 30);
    const importedFirst = await importVendorOrder(
      ctx.db,
      first,
      ctx.actor.userId,
    );
    const importedSecond = await importVendorOrder(
      ctx.db,
      second,
      ctx.actor.userId,
    );
    const aliases = await db
      .select()
      .from(importSourceClaim)
      .where(eq(importSourceClaim.ledgerPartyId, party.id));
    const firstAlias = aliases.find(
      (row) => row.externalKey === first.source.externalKey,
    );
    const secondAlias = aliases.find(
      (row) => row.externalKey === second.source.externalKey,
    );
    if (!firstAlias || !secondAlias)
      throw new Error("Synthetic historical aliases missing");
    const [root] = await db
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: party.id,
        vendorAccountId: account.id,
        kind: "browser_order",
        externalKey: canonicalKey,
        checksum: first.source.checksum,
        firstRunId: run.id,
        lastRunId: run.id,
      })
      .returning();
    if (!root) throw new Error("Synthetic canonical source missing");
    const rootId = root.id;
    async function canonicalize() {
      await db.execute(
        sql`UPDATE "ImportSourceClaim" SET "canonicalClaimId" = ${rootId}::uuid WHERE "id" IN (${firstAlias!.id}::uuid, ${secondAlias!.id}::uuid)`,
      );
    }
    async function prepare(value: ImportWriterInput, operationId: string) {
      const result = await preparePurchaseImport(
        ctx.db,
        {
          _runExecution: { runId: run.id, operationId },
          orders: [
            {
              stableOrderId: `${operationId}:order`,
              itemOperationId: `${operationId}:item`,
              source: value.source,
              evidenceChecksum: value.source.checksum,
              extractionRevision: "example-family-v1",
              extraction: value.extraction,
              lineIds: [`${operationId}:line`],
              primaryDocumentImageId: null,
              screenshotImageId: null,
            },
          ],
        },
        ctx.actor,
      );
      return result.orders[0]!.targetFingerprint;
    }
    return {
      db,
      party,
      root,
      firstAlias,
      secondAlias,
      first,
      second,
      importedFirst,
      importedSecond,
      canonicalize,
      prepare,
    };
  }

  it("replays canonical orders with historical IDs, payment bytes, money and preparation fingerprint intact", async () => {
    const f = await world();
    const fingerprint = await f.prepare(f.first, "prepare:before-family");
    await f.canonicalize();
    const associations = await f.db.select().from(importSourceOrder);
    const payments = await f.db.select().from(purchasePaymentEvidence);
    const expenses = await f.db.select().from(expense);
    const canonical = {
      ...f.first,
      source: { ...f.first.source, externalKey: canonicalKey },
    };
    const result = await importVendorOrder(ctx.db, canonical, ctx.actor.userId);
    expect(result).toMatchObject({
      outcome: "replayed",
      purchaseId: f.importedFirst.purchaseId,
      outputFingerprint: f.importedFirst.outputFingerprint,
    });
    expect(await f.db.select().from(importSourceOrder)).toEqual(associations);
    expect(await f.db.select().from(purchasePaymentEvidence)).toEqual(payments);
    expect(await f.db.select().from(expense)).toEqual(expenses);
    expect(await f.prepare(canonical, "prepare:after-family")).toBe(
      fingerprint,
    );
  });

  it("refreshes the actual historical owner's payment group while leaving sibling history intact", async () => {
    const f = await world();
    await f.canonicalize();
    const sibling = await f.db
      .select()
      .from(importSourceOrder)
      .where(eq(importSourceOrder.sourceClaimId, f.secondAlias.id));
    const siblingPayments = await f.db
      .select()
      .from(purchasePaymentEvidence)
      .where(eq(purchasePaymentEvidence.sourceClaimId, f.secondAlias.id));
    const refreshed = {
      ...f.first,
      source: {
        ...f.first.source,
        externalKey: canonicalKey,
        checksum: "b".repeat(64),
      },
      extraction: {
        ...f.first.extraction,
        candidate: {
          ...f.first.extraction.candidate!,
          payments: [
            {
              amount: 20,
              chargedAt: "2026-09-03T12:00:00.000Z",
              cardLastFour: "1234",
              description: "Updated retained payment",
            },
          ],
        },
      },
    };
    await importVendorOrder(ctx.db, refreshed, ctx.actor.userId);
    const payments = await f.db
      .select()
      .from(purchasePaymentEvidence)
      .where(
        eq(
          purchasePaymentEvidence.purchaseId,
          parseEntityId("purchase", f.importedFirst.purchaseId),
        ),
      );
    expect(payments).toMatchObject([
      {
        sourceClaimId: f.firstAlias.id,
        description: "Updated retained payment",
        amount: 20,
      },
    ]);
    expect(payments).toHaveLength(1);
    expect(
      await f.db
        .select()
        .from(importSourceOrder)
        .where(eq(importSourceOrder.sourceClaimId, f.secondAlias.id)),
    ).toEqual(sibling);
    expect(
      await f.db
        .select()
        .from(purchasePaymentEvidence)
        .where(eq(purchasePaymentEvidence.sourceClaimId, f.secondAlias.id)),
    ).toEqual(siblingPayments);
    const [secondAlias] = await f.db
      .select()
      .from(importSourceClaim)
      .where(eq(importSourceClaim.id, f.secondAlias.id));
    expect(secondAlias).toEqual({
      ...f.secondAlias,
      canonicalClaimId: f.root.id,
    });
    const [root] = await f.db
      .select()
      .from(importSourceClaim)
      .where(eq(importSourceClaim.id, f.root.id));
    expect(root?.checksum).toBe(refreshed.source.checksum);
    const [first] = await f.db
      .select()
      .from(importSourceOrder)
      .where(eq(importSourceOrder.sourceClaimId, f.firstAlias.id));
    expect(first?.originalOrder?.checksum).toBe(f.first.source.checksum);
    expect(first?.checksum).toBe(refreshed.source.checksum);
  });

  it("refuses duplicate family order associations even when they name the same Purchase", async () => {
    const f = await world();
    await f.canonicalize();
    const [original] = await f.db
      .select()
      .from(importSourceOrder)
      .where(eq(importSourceOrder.sourceClaimId, f.firstAlias.id));
    if (!original) throw new Error("Synthetic association missing");
    await f.db.insert(importSourceOrder).values({
      sourceClaimId: f.root.id,
      orderKey: original.orderKey,
      purchaseId: original.purchaseId,
      checksum: original.checksum,
      outputFingerprint: original.outputFingerprint,
      originalOrder: original.originalOrder,
    });
    const canonical = {
      ...f.first,
      source: { ...f.first.source, externalKey: canonicalKey },
    };
    await expect(
      importVendorOrder(ctx.db, canonical, ctx.actor.userId),
    ).rejects.toThrow(/duplicate.*source.*order|source.*order.*ambiguous/iu);
    await expect(f.prepare(canonical, "prepare:collision")).rejects.toThrow(
      /duplicate.*source.*order|source.*order.*ambiguous/iu,
    );
  });

  it.each(["foreign_alias", "incoming_alias"] as const)(
    "retains the entire source graph when reading a family with a %s",
    async (problem) => {
      const f = await world();
      await f.canonicalize();
      let externalKey = canonicalKey;
      if (problem === "foreign_alias") {
        const other = await insertWithShortcode(ctx.db, "ledgerParty", {
          name: "Other synthetic source owner",
          kind: "member",
        });
        await f.db
          .update(importSourceClaim)
          .set({ ledgerPartyId: other.id })
          .where(eq(importSourceClaim.id, f.secondAlias.id));
      } else {
        externalKey = "synthetic:incoming-source-alias";
        await f.db.insert(importSourceClaim).values({
          ledgerPartyId: f.party.id,
          kind: f.root.kind,
          externalKey,
          canonicalClaimId: f.firstAlias.id,
          checksum: f.root.checksum,
          firstRunId: f.root.firstRunId,
          lastRunId: f.root.lastRunId,
        });
      }
      const before = {
        claims: await f.db.select().from(importSourceClaim),
        orders: await f.db.select().from(importSourceOrder),
        payments: await f.db.select().from(purchasePaymentEvidence),
        expenses: await f.db.select().from(expense),
      };
      await expect(
        readImportSourceClaimFamily(f.db, {
          ledgerPartyId: f.party.id,
          kind: f.root.kind,
          externalKey,
        }),
      ).rejects.toThrow(
        problem === "foreign_alias"
          ? "crosses member ownership"
          : "invalid canonical owner",
      );
      expect(await f.db.select().from(importSourceClaim)).toEqual(
        before.claims,
      );
      expect(await f.db.select().from(importSourceOrder)).toEqual(
        before.orders,
      );
      expect(await f.db.select().from(purchasePaymentEvidence)).toEqual(
        before.payments,
      );
      expect(await f.db.select().from(expense)).toEqual(before.expenses);
    },
  );

  it("refuses an unmapped historical Gmail order key with a null canonical pointer as a writable identity", async () => {
    const f = await world();
    const oldKey = "gmail:example-message:order:EXAMPLE-101";
    const [unmapped] = await f.db
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: f.party.id,
        kind: "mail_message",
        externalKey: oldKey,
        checksum: f.first.source.checksum,
        firstRunId: f.first.runId,
        lastRunId: f.first.runId,
      })
      .returning();
    if (!unmapped) throw new Error("Synthetic unmapped source missing");
    const [original] = await f.db
      .select()
      .from(importSourceOrder)
      .where(eq(importSourceOrder.sourceClaimId, f.firstAlias.id));
    if (!original) throw new Error("Synthetic historical association missing");
    await f.db.insert(importSourceOrder).values({
      sourceClaimId: unmapped.id,
      orderKey: original.orderKey,
      purchaseId: original.purchaseId,
      checksum: original.checksum,
      outputFingerprint: original.outputFingerprint,
      originalOrder: original.originalOrder,
    });
    expect(unmapped.canonicalClaimId).toBeNull();
    const legacy = {
      ...f.first,
      source: {
        kind: "mail_message" as const,
        externalKey: oldKey,
        checksum: f.first.source.checksum,
      },
    };
    await expect(
      importVendorOrder(ctx.db, legacy, ctx.actor.userId),
    ).rejects.toThrow(/historical|canonical/iu);
  });

  it("refuses an old alias as a writable writer or prepared identity", async () => {
    const f = await world();
    await f.canonicalize();
    await expect(
      importVendorOrder(ctx.db, f.first, ctx.actor.userId),
    ).rejects.toThrow(/alias|canonical/iu);
    await expect(f.prepare(f.first, "prepare:alias")).rejects.toThrow(
      /alias|canonical/iu,
    );
  });
});
