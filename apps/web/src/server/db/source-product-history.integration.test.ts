import { readFileSync } from "node:fs";
import { join } from "node:path";

import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  importSourceClaim,
  importSourceOrder,
  importSourceProduct,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";

const migration = readFileSync(
  join(import.meta.dirname, "../../../drizzle/0025_purchase_research.sql"),
  "utf8",
);
// Exercise the data transform against the migrated schema, including historical
// soft-deleted identities. Malformed references must abort before JSON removal.
describe("original order Product history migration", () => {
  const ctx = withTestDb();
  async function legacy(productId?: string) {
    const db = getDb(ctx.db);
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "History owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example catalog",
    });
    const item = await insertWithShortcode(ctx.db, "product", {
      name: "Small blue variant",
      manufacturer: "Example maker",
      deletedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: null,
      deletedAt: new Date("2026-01-02T00:00:00Z"),
    });
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "account_sync",
      trigger: "manual",
      status: "completed",
    });
    const [claim] = await db
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: party.id,
        kind: "mail_message",
        externalKey: "synthetic:legacy-source",
        checksum: "a".repeat(64),
        firstRunId: runId,
        lastRunId: runId,
      })
      .returning();
    if (!claim) throw new Error("Synthetic claim missing");
    const original = {
      checksum: "a".repeat(64),
      extraction: {
        status: "ready",
        candidate: { lines: [{ title: "Small blue variant" }] },
      },
      productLines: [{ lineIndex: 0, productId: productId ?? item.id }],
    };
    const [source] = await db
      .insert(importSourceOrder)
      .values({
        sourceClaimId: claim.id,
        orderKey: "id:EXAMPLE-HISTORY",
        purchaseId: purchase.id,
        checksum: "a".repeat(64),
        outputFingerprint: "b".repeat(64),
      })
      .returning();
    if (!source) throw new Error("Synthetic source missing");
    await db.execute(
      sql`UPDATE "ImportSourceOrder" SET "originalOrder" = ${JSON.stringify(original)}::jsonb WHERE id = ${source.id}`,
    );
    return { db, source, item, original };
  }
  const transform = async () => {
    await getDb(ctx.db).transaction(async (tx) => {
      for (const statement of migration
        .split("--> statement-breakpoint")
        .map((part) => part.replace(/^(\s*--[^\n]*(?:\n|$))+/u, "").trim())
        .filter(
          (part) =>
            /^(DO|INSERT|UPDATE)\b/u.test(part) &&
            part.includes("'productLines'"),
        ))
        await tx.execute(sql.raw(statement));
    });
  };
  it("moves every original binding including deleted records, preserves source bytes, and replays", async () => {
    const f = await legacy();
    await transform();
    await transform();
    const bindings = await f.db
      .select()
      .from(importSourceProduct)
      .where(eq(importSourceProduct.sourceOrderId, f.source.id));
    expect(bindings).toMatchObject([
      { sourceOrderId: f.source.id, lineIndex: 0, productId: f.item.id },
    ]);
    const [source] = await f.db
      .select()
      .from(importSourceOrder)
      .where(eq(importSourceOrder.id, f.source.id));
    expect(source?.originalOrder).toEqual({
      checksum: f.original.checksum,
      extraction: f.original.extraction,
    });
  });
  it("refuses a missing Product without erasing the original binding", async () => {
    const f = await legacy(crypto.randomUUID());
    await expect(transform()).rejects.toThrow(
      /original.*Product|Product.*binding/iu,
    );
    const [source] = await f.db
      .select()
      .from(importSourceOrder)
      .where(eq(importSourceOrder.id, f.source.id));
    expect(source?.originalOrder).toEqual(f.original);
  });
  it("refuses conflicting duplicate line bindings instead of discarding one Product", async () => {
    const f = await legacy();
    const other = await insertWithShortcode(ctx.db, "product", {
      name: "Large red variant",
      manufacturer: "Example maker",
    });
    const original = {
      ...f.original,
      productLines: [
        ...f.original.productLines,
        { lineIndex: 0, productId: other.id },
      ],
    };
    await f.db.execute(
      sql`UPDATE "ImportSourceOrder" SET "originalOrder" = ${JSON.stringify(original)}::jsonb WHERE id = ${f.source.id}`,
    );
    await expect(transform()).rejects.toThrow(
      /duplicate.*Product|Product.*binding/iu,
    );
    const [source] = await f.db
      .select()
      .from(importSourceOrder)
      .where(eq(importSourceOrder.id, f.source.id));
    expect(source?.originalOrder).toEqual(original);
    expect(
      await f.db
        .select()
        .from(importSourceProduct)
        .where(eq(importSourceProduct.sourceOrderId, f.source.id)),
    ).toEqual([]);
  });
});
