import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { run, runTarget } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { sweepPendingEnrichment } from "./enrichment-sweep";
import { productResearchFixture } from "./product-research.fixtures";

describe("source-owned Product research sweep", () => {
  const ctx = withTestDb();
  it("starts owned offline import work even with manually filled facts and an owned cover", async () => {
    const f = await productResearchFixture(ctx.db, ctx.actor, {
      complete: true,
    });
    const events: unknown[] = [];
    const result = await sweepPendingEnrichment(ctx.db, {
      queue: {
        send: async (event: PurchaseAgentEvent) => {
          events.push(event);
        },
      },
    });
    expect(result.started).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(runTarget)).toMatchObject([
      { entityId: f.item.entityId, entityKind: "product", state: "pending" },
    ]);
    const [child] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.purpose, "product_enrichment"));
    expect(child).toMatchObject({
      vendorAccountId: null,
      ledgerPartyId: f.party.id,
      parentRunId: f.parent.id,
    });
    expect(events).toHaveLength(1);
  });
  it("treats historical skipped completion as unverified and finds legacy audit-backed purchases beyond sixty days", async () => {
    const f = await productResearchFixture(ctx.db, ctx.actor, { legacy: true });
    const legacy = await insertWithShortcode(ctx.db, "run", {
      purpose: "product_enrichment",
      trigger: "manual",
      status: "completed",
      ledgerPartyId: f.party.id,
      actorUserId: ctx.actor.userId,
      actorName: f.party.name,
      actorEmail: "research@example.test",
      actorLedgerPartyShortcode: f.party.shortcode,
      actorLedgerPartyName: f.party.name,
      actorLedgerPartyKind: "member",
    });
    await getDb(ctx.db).insert(runTarget).values({
      runId: legacy.id,
      entityKind: "product",
      entityId: f.item.entityId,
      state: "skipped",
      outcome: "skipped",
      targetFingerprint: "synthetic-legacy",
    });
    const result = await sweepPendingEnrichment(ctx.db, {
      now: new Date("2027-12-01T00:00:00Z"),
      queue: { send: async () => {} },
    });
    expect(result.started).toHaveLength(1);
    const targets = await getDb(ctx.db).select().from(runTarget);
    expect(targets).toHaveLength(2);
    expect(targets).toContainEqual(
      expect.objectContaining({
        runId: legacy.id,
        state: "skipped",
        outcome: "skipped",
      }),
    );
    expect(targets).toContainEqual(
      expect.objectContaining({ entityId: f.item.entityId, state: "pending" }),
    );
  });
});
