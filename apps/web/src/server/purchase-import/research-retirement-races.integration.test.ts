import { runEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { run, runOperation } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import {
  executeAtomicOperation,
  executeLeasedOperation,
} from "~/server/runs/operation";

// Retirement can commit while a network read or semantic assessment is in flight.
// Its late completion or failure must not repopulate disposable source content.
describe("retired research operation races", () => {
  const ctx = withTestDb();
  async function fixture() {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic retirement member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const scope = await insertWithShortcode(ctx.db, "run", {
      purpose: "mail_import",
      status: "running",
      trigger: "manual",
      ledgerPartyId: member.id,
      actorUserId: ctx.actor.userId,
      actorName: member.name,
      actorEmail: "retirement@example.test",
      actorLedgerPartyShortcode: member.shortcode,
      actorLedgerPartyName: member.name,
      actorLedgerPartyKind: "member",
    });
    const retire = async () => {
      await getDb(ctx.db)
        .update(run)
        .set({
          retiredAt: new Date(),
          retirementReason: "unrelated_source",
          status: "needs_review",
        })
        .where(eq(run.id, scope.id));
    };
    return { scope, retire };
  }
  it("rejects a late leased result instead of caching erased source content", async () => {
    const f = await fixture();
    await expect(
      executeLeasedOperation(
        ctx.db,
        {
          runId: f.scope.id,
          operationId: "synthetic-in-flight-read",
          kind: "research_mail_read",
          payload: {},
        },
        async () => {
          await f.retire();
          return { text: "Synthetic unrelated private source" };
        },
      ),
    ).rejects.toThrow(/retired/i);
    const rows = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .where(eq(runOperation.runId, f.scope.id));
    expect(rows.every((row) => row.result === null)).toBe(true);
  });
  it("does not recreate a refused proposal after its coordinator was retired", async () => {
    const f = await fixture();
    await expect(
      executeAtomicOperation(
        ctx.db,
        {
          runId: runEntityId.parse(f.scope.id),
          operationId: "synthetic-in-flight-assessment",
          kind: "research_resolve_import",
          payload: { detail: "Synthetic unrelated private source" },
          subject: "Synthetic research",
          recordFailure: true,
          retainAttempt: true,
        },
        async () => {
          await f.retire();
          throw new Error("Synthetic assessment interrupted");
        },
      ),
    ).rejects.toThrow("Synthetic assessment interrupted");
    expect(
      await getDb(ctx.db)
        .select()
        .from(runOperation)
        .where(eq(runOperation.runId, f.scope.id)),
    ).toEqual([]);
  });
});
