import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  importPreparedLine,
  importPreparedOrder,
  runTarget,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { loadRunDetail, startOrResumeRun } from "./run-service";

describe("immutable prepared purchase review", () => {
  const ctx = withTestDb();

  // The review must preserve persisted line order and adjustment membership,
  // while withholding UUIDs and arbitrary extraction/line payload fields.
  it("projects ordered immutable lines without private operation payloads", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Prepared review member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Prepared review vendor",
      website: "https://shop.example.test",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Prepared review account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const [order] = await getDb(ctx.db)
      .insert(importPreparedOrder)
      .values({
        runId: run.id,
        prepareOperationId: "prepare:review",
        itemOperationId: "item:review",
        stableOrderId: "order:review",
        sourceKind: "browser_order",
        sourceExternalKey: "review-order",
        sourceChecksum: "a".repeat(64),
        evidenceChecksum: "b".repeat(64),
        extractionRevision: "review@1",
        extraction: { privatePayload: run.id },
        targetFingerprint: "c".repeat(64),
        evidenceFingerprint: "d".repeat(64),
      })
      .returning({ id: importPreparedOrder.id });
    if (!order) throw new Error("Prepared order fixture missing");
    await getDb(ctx.db)
      .insert(importPreparedLine)
      .values([
        {
          preparedOrderId: order.id,
          stableLineId: "line:shipping",
          position: 1,
          line: {
            title: "Shipping",
            amount: 2,
            lineKind: "shipping",
            privatePayload: run.id,
          },
          identifiers: {},
          candidates: [],
        },
        {
          preparedOrderId: order.id,
          stableLineId: "line:product",
          position: 0,
          line: {
            title: "Fixture product",
            amount: 12,
            lineKind: "principal",
            privatePayload: run.id,
          },
          identifiers: { sku: "FIXTURE-01" },
          candidates: [],
        },
      ]);

    const detail = await loadRunDetail(ctx.db, run.publicId);
    expect(detail.preparedOrders[0]).toMatchObject({
      prepareOperationId: "prepare:review",
      lineCount: 2,
      lines: [
        {
          stableLineId: "line:product",
          title: "Fixture product",
          amount: 12,
          identifiers: { sku: "FIXTURE-01" },
          candidates: [],
          requiresProductResolution: true,
        },
        {
          stableLineId: "line:shipping",
          title: "Shipping",
          amount: 2,
          requiresProductResolution: false,
        },
      ],
    });
    const publicReview = JSON.stringify(detail.preparedOrders);
    expect(publicReview).not.toContain(run.id);
    expect(publicReview).not.toContain(order.id);
    expect(publicReview).not.toContain("privatePayload");
  });

  // Run detail once named every target by its bare kind ("product").
  it("names each target by its record's name", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Target name member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Target name vendor",
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Target name account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Fixture Nasturtium",
      manufacturer: "Fixture Seeds",
    });
    await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: run.id,
        entityKind: "product",
        entityId: product.id,
        position: 0,
        targetFingerprint: "e".repeat(64),
      });

    const detail = await loadRunDetail(ctx.db, run.publicId);
    expect(detail.targets).toHaveLength(2);
    expect(detail.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetType: "run",
          targetName: "account_sync",
        }),
        expect.objectContaining({
          targetType: "product",
          targetShortcode: product.shortcode,
          targetName: "Fixture Nasturtium",
        }),
      ]),
    );
  });
});
