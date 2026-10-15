import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { runOperation } from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { listProductRuns } from "../repo/run-target";
import { startAgentRunFixture } from "./import-run.fixtures";

// A successful no-op has no AuditLog or finding. Retiring its mutable target
// must preserve attribution through the immutable operation outcome receipt.
describe("retired Run target history", () => {
  const ctx = withTestDb();
  it("lists a Product's no-op Run from its operation receipt without admitting a target row", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic history owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const owned = await startAgentRunFixture(ctx.db, {
      ledgerPartyId: party.id,
    });
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic receipt subject",
      manufacturer: "Synthetic manufacturer",
    });
    const other = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic unrelated subject",
      manufacturer: "Synthetic manufacturer",
    });
    await getDb(ctx.db)
      .insert(runOperation)
      .values({
        runId: owned.id,
        operationId: "migrated-target:synthetic-target",
        kind: "target_outcome",
        inputFingerprint: "a".repeat(64),
        state: "completed",
        completedAt: new Date(),
        result: {
          target: {
            entityKind: "product",
            entityId: product.id,
            workKey: "",
            state: "completed",
            outcome: "enriched",
            warning: null,
            diff: null,
            completedAt: new Date().toISOString(),
            targetFingerprint: "b".repeat(64),
          },
        },
      });
    expect(
      (await listProductRuns(ctx.db, party.id, product.id)).map(
        (row) => row.id,
      ),
    ).toEqual([owned.id]);
    expect(await listProductRuns(ctx.db, party.id, other.id)).toEqual([]);
  });
});
