import { importRunAgentIdentity } from "@cubby/schemas/import-run-agent";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  importSourceClaim,
  importSourceOrder,
  orderMail,
  run,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";

import { sourceOrderKey } from "./source-order-key";
import { loadTargetedImportLaunch, startTargetedImport } from "./targeted-run";

// A consolidated message must expose each order separately. Raw source IDs,
// foreign order selections, and newer raw bytes must not change replay scope.
describe("targeted source-order associations", () => {
  const ctx = withTestDb();

  async function source() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Source association member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Source association vendor",
    });
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "account_sync",
      trigger: "manual",
      status: "running",
    });
    const first = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "EXAMPLE-201",
      date: "2026-09-01",
    });
    const second = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "EXAMPLE-202",
      date: "2026-09-02",
    });
    const [claim] = await getDb(ctx.db)
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: party.id,
        kind: "mail_message",
        externalKey: "gmail:synthetic-mailbox:consolidated",
        checksum: "c".repeat(64),
        firstRunId: runId,
        lastRunId: runId,
      })
      .returning();
    if (!claim) throw new Error("Synthetic source claim did not persist");
    const associations = await getDb(ctx.db)
      .insert(importSourceOrder)
      .values([
        {
          sourceClaimId: claim.id,
          orderKey: sourceOrderKey({
            vendorId: vendor.id,
            orderId: first.orderId,
          }),
          purchaseId: first.id,
          checksum: "a".repeat(64),
          outputFingerprint: "first-order",
        },
        {
          sourceClaimId: claim.id,
          orderKey: sourceOrderKey({
            vendorId: vendor.id,
            orderId: second.orderId,
          }),
          purchaseId: second.id,
          checksum: "b".repeat(64),
          outputFingerprint: "second-order",
        },
      ])
      .returning();
    const [firstAssociation, secondAssociation] = associations;
    if (!firstAssociation || !secondAssociation)
      throw new Error("Synthetic source orders did not persist");
    return {
      party,
      vendor,
      runId,
      first,
      second,
      claim,
      firstAssociation,
      secondAssociation,
    };
  }

  it("offers the specific order association and retained checksum from a shared message", async () => {
    const fixture = await source();
    const first = await loadTargetedImportLaunch(
      ctx.db,
      fixture.party.id,
      "purchase_validation",
      fixture.first.shortcode,
    );
    const second = await loadTargetedImportLaunch(
      ctx.db,
      fixture.party.id,
      "purchase_validation",
      fixture.second.shortcode,
    );
    expect(first.purchase?.sources).toMatchObject([
      { id: fixture.firstAssociation.id, fingerprint: "a".repeat(64) },
    ]);
    expect(second.purchase?.sources).toMatchObject([
      { id: fixture.secondAssociation.id, fingerprint: "b".repeat(64) },
    ]);
    expect(first.purchase?.sources).toHaveLength(1);
    expect(second.purchase?.sources).toHaveLength(1);
  });

  it("refuses a raw source ID or another order's association instead of dropping the explicit selection", async () => {
    const fixture = await source();
    for (const sourceId of [fixture.claim.id, fixture.secondAssociation.id]) {
      await expect(
        startTargetedImport(ctx.db, fixture.party.id, {
          purpose: "purchase_validation",
          purchaseId: fixture.first.shortcode,
          sourceId,
        }),
      ).rejects.toThrow("Selected validation source is not owned");
    }
  });

  it("uses an order association when launching enrichment for its purchased Product", async () => {
    const fixture = await source();
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic workshop material",
      manufacturer: "Synthetic workshop",
    });
    await insertWithShortcode(ctx.db, "expense", {
      purchaseId: fixture.second.id,
      productId: product.id,
      name: "Synthetic material",
      cost: 18,
      date: "2026-09-02",
      costType: "materials",
      trade: "other",
      lineKind: "principal",
    });
    await getDb(ctx.db)
      .update(importSourceOrder)
      .set({ checksum: fixture.claim.checksum })
      .where(eq(importSourceOrder.id, fixture.secondAssociation.id));
    const launch = await loadTargetedImportLaunch(
      ctx.db,
      fixture.party.id,
      "product_enrichment",
      product.shortcode,
    );
    expect(launch.products).toMatchObject([
      { productId: product.shortcode, sourceId: fixture.secondAssociation.id },
    ]);
  });

  it("authorizes several orders from retained mail without accepting an unassigned source or altered bytes", async () => {
    const fixture = await source();
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: fixture.party.id,
        mailboxId: "synthetic-mailbox",
        messageId: "consolidated",
        sender: "receipts@example.test",
        subject: "Several workshop orders",
        receivedAt: new Date("2026-09-01T18:00:00Z"),
        rawChecksum: "c".repeat(64),
        content: {
          snippet: null,
          bodyText: "Two workshop orders",
          bodyHtml: null,
        },
      })
      .returning();
    if (!mail) throw new Error("Synthetic retained mail did not persist");
    await getDb(ctx.db)
      .update(run)
      .set({
        ledgerPartyId: fixture.party.id,
        vendorId: fixture.vendor.id,
        agentSessionId: importRunAgentIdentity(fixture.runId, "account_sync"),
        input: {
          kind: "mail_research",
          mailboxId: mail.mailboxId,
          sources: [{ orderMailId: mail.id, checksum: mail.rawChecksum }],
        },
      })
      .where(eq(run.id, fixture.runId));
    const { preparePurchaseImport } = await import("./import-orders");
    const orders = [fixture.first, fixture.second].map((purchase, index) => ({
      stableOrderId: `source-order-${index}`,
      itemOperationId: `prepare-item-${index}`,
      source: {
        kind: "mail_message" as const,
        externalKey: fixture.claim.externalKey,
        checksum: mail.rawChecksum,
      },
      evidenceChecksum: mail.rawChecksum,
      extractionRevision: "synthetic-v1",
      extraction: {
        status: "ready" as const,
        candidate: {
          orderId: purchase.orderId,
          orderedAt: "2026-09-01T18:00:00Z",
          merchant: "Source association vendor",
          currency: "USD",
          printedGrandTotal: null,
          lines: [],
          payments: [],
          allShipmentsDelivered: false,
        },
      },
      lineIds: [],
      primaryDocumentImageId: null,
      screenshotImageId: null,
    }));
    for (const source of [
      {
        ...orders[0]!.source,
        externalKey: "gmail:synthetic-mailbox:unassigned",
      },
      { ...orders[0]!.source, checksum: "d".repeat(64) },
    ]) {
      await expect(
        preparePurchaseImport(
          ctx.db,
          {
            _runExecution: {
              runId: fixture.runId,
              operationId: "prepare:unauthorized",
            },
            orders: [{ ...orders[0]!, source }],
          },
          ctx.actor,
        ),
      ).rejects.toThrow("assigned retained mail source");
    }
    const prepared = await preparePurchaseImport(
      ctx.db,
      {
        _runExecution: {
          runId: fixture.runId,
          operationId: "prepare:consolidated",
        },
        orders,
      },
      ctx.actor,
    );
    expect(prepared.orders).toHaveLength(2);
  });
});
