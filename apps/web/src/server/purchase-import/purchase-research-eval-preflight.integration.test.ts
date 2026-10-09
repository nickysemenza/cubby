import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { vendor } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

import { startProductResearch } from "./product-research-run";
import {
  prepareResearchEvalFixture,
  researchEvalCases,
} from "./purchase-research-eval.fixtures";
import { loadProductPurchaseContext } from "./research-context";

describe("research eval preflight", () => {
  const ctx = withTestDb();
  it("admits both pilot cases with independent owned mail and exact original Product lines before inference", async () => {
    const fixtures = [];
    for (const scenario of researchEvalCases.slice(0, 2)) {
      fixtures.push(
        await prepareResearchEvalFixture(ctx.db, ctx.actor, scenario),
      );
    }
    expect(fixtures[0]!.party.id).toBe(fixtures[1]!.party.id);
    // Both retained pages belong to one seller; pre-admitting another case
    // must not create competing canonical issuers before paid research starts.
    expect(fixtures[0]!.order.vendorId).toBe(fixtures[1]!.order.vendorId);
    expect(
      await getDb(ctx.db)
        .select()
        .from(vendor)
        .where(eq(vendor.website, "https://maker.example.test")),
    ).toHaveLength(1);
    const sourceKeys = [];
    const events: PurchaseAgentEvent[] = [];
    for (const [index, fixture] of fixtures.entries()) {
      const [admission] = await startProductResearch(
        ctx.db,
        {
          ledgerPartyId: fixture.party.id,
          userId: ctx.actor.userId,
          productIds: [fixture.item.entityId],
          cause: "member_request",
        },
        {
          send: async (event) => {
            events.push(event);
          },
        },
      );
      expect(admission?.created).toBe(true);
      const context = await loadProductPurchaseContext(ctx.db, {
        productId: fixture.item.entityId,
        ledgerPartyId: fixture.party.id,
      });
      expect(context).toHaveLength(1);
      expect(context[0]!.orderedLine?.title).toBe(
        researchEvalCases[index]!.orderedTitle,
      );
      expect(context[0]!.source.kind).toBe("mail_message");
      expect(context[0]!.source.externalKey).toMatch(/^[a-f0-9-]{36}$/u);
      sourceKeys.push(context[0]!.source.externalKey);
    }
    expect(new Set(sourceKeys).size).toBe(2);
    expect(new Set(events.map((event) => event.runId)).size).toBe(2);
  });
});
