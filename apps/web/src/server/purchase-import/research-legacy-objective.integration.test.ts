import { runEntityId } from "@cubby/schemas/identifiers";
import { importRunAgentIdentity } from "@cubby/schemas/import-run-agent";
import { researchObjectivesRunInput } from "@cubby/schemas/run-fields";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  financialTransaction,
  financialTransactionAllocation,
  importHunt,
  run,
  runOperation,
  runTarget,
  vendorAccount,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { executeLeasedOperation } from "~/server/runs/operation";

import { productResearchFixture } from "./product-research.fixtures";
import { researchServiceFor } from "./research-service";
import { controlRun, startOrResumeRun } from "./run-service";

// Historical scopes must not use today's account cursor, broaden selected
// Hunts, discard observed charge facts, copy stale tasks, or change money.
describe("historical objective conversion", () => {
  const ctx = withTestDb();
  const range = { from: "2026-08-01", to: "2026-08-31" };
  async function fixture(kind: "backfill" | "charges" | "sync") {
    const f = await productResearchFixture(ctx.db, ctx.actor);
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: f.order.vendorId,
      ledgerPartyId: f.party.id,
      label: "Synthetic historical research account",
      browserSyncEnabled: true,
    });
    const card = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Synthetic historical charge account",
      ledgerPartyId: f.party.id,
      identity: { kind: "credit_card", issuer: null, network: "visa" },
    });
    const hunts: {
      name: string;
      hunt: typeof importHunt.$inferSelect;
      transaction: typeof financialTransaction.$inferSelect;
    }[] = [];
    if (kind === "charges")
      for (const name of ["claimed", "unvisited", "settled"]) {
        const transaction = await insertWithShortcode(
          ctx.db,
          "financialTransaction",
          {
            accountId: card.id,
            kind: "purchase",
            status: "posted",
            amount: name === "claimed" ? 12.34 : 7.5,
            merchant: "Synthetic historical seller",
            rawDescription: `Synthetic ${name} charge`,
            transactionDate: null,
            postedDate: "2026-09-15",
          },
        );
        const [hunt] = await getDb(ctx.db)
          .insert(importHunt)
          .values({
            ledgerPartyId: f.party.id,
            financialTransactionId: transaction.id,
            vendorAccountId: account.id,
            vendorId: account.vendorId,
            state: "browser_queued",
            dateFrom: "2026-09-01",
            dateTo: "2026-09-30",
          })
          .returning();
        if (!hunt) throw new Error("Synthetic historical Hunt missing.");
        hunts.push({ name, hunt, transaction });
      }
    const launchInput: Parameters<typeof startOrResumeRun>[1] = {
      ledgerPartyId: f.party.id,
      vendorAccountId: account.id,
      trigger: kind === "backfill" ? "backfill" : "manual",
    };
    if (kind === "backfill") launchInput.backfill = range;
    if (kind === "charges")
      launchInput.chargeHuntIds = hunts.map(({ hunt }) => hunt.id);
    const launched = await startOrResumeRun(ctx.db, launchInput);
    const [original] = await getDb(ctx.db)
      .update(run)
      .set({
        status: "needs_review",
        endedAt: new Date("2026-09-20T18:00:00Z"),
        attempt: null,
        parentRunId: f.parent.id,
        input:
          kind === "backfill"
            ? { kind: "order_backfill", ...range }
            : kind === "charges"
              ? {
                  kind: "charge_hunts",
                  huntIds: hunts.map(({ hunt }) => hunt.id),
                }
              : null,
      })
      .where(eq(run.id, launched.id))
      .returning();
    if (!original) throw new Error("Synthetic historical Run missing.");
    const originalId = original.id;
    await getDb(ctx.db)
      .delete(runTarget)
      .where(eq(runTarget.runId, original.id));
    async function claim(amount = 12.34) {
      const claimed = hunts.find(({ name }) => name === "claimed");
      if (!claimed) throw new Error("Synthetic claimed Hunt missing.");
      await executeLeasedOperation(
        ctx.db,
        {
          runId: originalId,
          operationId: crypto.randomUUID(),
          kind: "claim_next_work",
          payload: { runId: originalId },
        },
        async () => ({
          kind: "hunt",
          id: claimed.hunt.id,
          orderIds: [],
          amount,
          dateFrom: claimed.hunt.dateFrom,
          dateTo: claimed.hunt.dateTo,
          startUrl: "https://shop.example.test/orders",
        }),
      );
    }
    return { f, account, card, hunts, original, claim };
  }
  it.each(["retry", "restart"] as const)(
    "converts exact saved backfill range through %s without adopting a newer cursor",
    async (action) => {
      const { f, account, original } = await fixture("backfill");
      const cursor = {
        newestOrderAt: "2026-10-01T18:00:00Z",
        orderIdsOnNewestDate: ["EXAMPLE-NEWER"],
        backfillBeforeOrderAt: null,
        earliestAvailableOrderAt: null,
      };
      await getDb(ctx.db)
        .update(vendorAccount)
        .set({ cursor })
        .where(eq(vendorAccount.id, account.id));
      const result = await controlRun(ctx.db, ctx.actor, {
        runPublicId: original.shortcode,
        action,
      });
      if (!("successorRunId" in result) || !result.successorRunId)
        throw new Error("Synthetic successor missing.");
      const id = runEntityId.parse(result.successorRunId);
      const [successor] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, id));
      expect(successor).toMatchObject({
        parentRunId: f.parent.id,
        predecessorRunId: original.id,
        attempt: null,
        cause: "retry",
      });
      expect(
        researchObjectivesRunInput.parse(successor?.input).objectives,
      ).toEqual([
        {
          kind: "account_history",
          vendorAccountId: account.id,
          range,
          cursor: null,
        },
      ]);
      expect(
        await researchServiceFor(ctx.db, fromPartial<Env>({}), id).researchNext(
          {},
          crypto.randomUUID(),
        ),
      ).toMatchObject({
        status: "working",
        work: { kind: "account_history", range, cursor: null },
      });
      expect(
        await getDb(ctx.db).select().from(run).where(eq(run.id, original.id)),
      ).toEqual([original]);
      await controlRun(ctx.db, ctx.actor, {
        runPublicId: successor!.shortcode,
        action: "cancel",
      });
      await getDb(ctx.db)
        .update(vendorAccount)
        .set({ deletedAt: new Date() })
        .where(eq(vendorAccount.id, account.id));
      expect(
        await controlRun(ctx.db, ctx.actor, {
          runPublicId: original.shortcode,
          action,
        }),
      ).toMatchObject({
        successorRunId: id,
        successorStatus: "failed",
        created: false,
      });
    },
  );
  it("converts the exact selected Hunt roster, retaining consistent observed facts and freezing unvisited context", async () => {
    const { f, hunts, original, claim } = await fixture("charges");
    await claim();
    const claimed = hunts.find(({ name }) => name === "claimed")!;
    const unvisited = hunts.find(({ name }) => name === "unvisited")!;
    const settled = hunts.find(({ name }) => name === "settled")!;
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ amount: 99 })
      .where(eq(financialTransaction.id, claimed.transaction.id));
    await getDb(ctx.db)
      .update(importHunt)
      .set({ dateFrom: "2026-11-01", dateTo: "2026-11-30" })
      .where(eq(importHunt.id, claimed.hunt.id));
    await getDb(ctx.db).insert(financialTransactionAllocation).values({
      transactionId: settled.transaction.id,
      purchaseId: f.order.id,
      amount: settled.transaction.amount,
    });
    const beforeAllocations = await getDb(ctx.db)
      .select()
      .from(financialTransactionAllocation);
    const beforeOperations = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .where(eq(runOperation.runId, original.id));
    const result = await controlRun(ctx.db, ctx.actor, {
      runPublicId: original.shortcode,
      action: "retry",
    });
    if (!("successorRunId" in result) || !result.successorRunId)
      throw new Error("Synthetic successor missing.");
    const id = runEntityId.parse(result.successorRunId);
    const [successor] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, id));
    const objectives = researchObjectivesRunInput.parse(
      successor?.input,
    ).objectives;
    expect(objectives).toHaveLength(2);
    expect(
      objectives.find(
        (objective) =>
          objective.kind === "charge_hunt" &&
          objective.huntId === claimed.hunt.id,
      ),
    ).toMatchObject({
      kind: "charge_hunt",
      financialTransactionId: claimed.transaction.id,
      range: { from: "2026-09-01", to: "2026-09-30" },
      charge: {
        amount: 12.34,
        merchant: null,
        rawDescription: null,
        transactionDate: null,
        postedDate: null,
      },
    });
    expect(
      objectives.find(
        (objective) =>
          objective.kind === "charge_hunt" &&
          objective.huntId === unvisited.hunt.id,
      ),
    ).toMatchObject({
      kind: "charge_hunt",
      financialTransactionId: unvisited.transaction.id,
      range: { from: unvisited.hunt.dateFrom, to: unvisited.hunt.dateTo },
      charge: {
        amount: unvisited.transaction.amount,
        transactionDate: null,
        postedDate: "2026-09-15",
      },
    });
    const next = await researchServiceFor(
      ctx.db,
      fromPartial<Env>({}),
      id,
    ).researchNext({}, crypto.randomUUID());
    expect(next).toMatchObject({
      status: "working",
      work: { kind: "charge_hunt" },
    });
    expect(
      await getDb(ctx.db).select().from(financialTransactionAllocation),
    ).toEqual(beforeAllocations);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runOperation)
        .where(eq(runOperation.runId, original.id)),
    ).toEqual(beforeOperations);
    expect(
      await getDb(ctx.db).select().from(run).where(eq(run.id, original.id)),
    ).toEqual([original]);
  });
  it("preserves every unresolved historical charge state through a failed typed child and its retry", async () => {
    const { hunts, original } = await fixture("charges");
    const states = ["pending_mail", "pending_browser", "exhausted"] as const;
    for (const [index, found] of hunts.entries())
      await getDb(ctx.db)
        .update(importHunt)
        .set({ state: states[index] })
        .where(eq(importHunt.id, found.hunt.id));
    const converted = await controlRun(ctx.db, ctx.actor, {
      runPublicId: original.shortcode,
      action: "retry",
    });
    if (!("successorRunId" in converted) || !converted.successorRunId)
      throw new Error("Synthetic successor missing.");
    const convertedId = runEntityId.parse(converted.successorRunId);
    const [child] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, convertedId));
    const frozen = researchObjectivesRunInput.parse(child?.input);
    expect(frozen.objectives).toHaveLength(3);
    await controlRun(ctx.db, ctx.actor, {
      runPublicId: child!.shortcode,
      action: "cancel",
    });
    const retried = await controlRun(ctx.db, ctx.actor, {
      runPublicId: child!.shortcode,
      action: "retry",
    });
    if (!("successorRunId" in retried) || !retried.successorRunId)
      throw new Error("Synthetic successor missing.");
    const retriedId = runEntityId.parse(retried.successorRunId);
    const [grandchild] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, retriedId));
    expect(grandchild).toMatchObject({
      predecessorRunId: convertedId,
      parentRunId: original.parentRunId,
      input: frozen,
      attempt: null,
    });
    expect(
      await researchServiceFor(
        ctx.db,
        fromPartial<Env>({}),
        retriedId,
      ).researchNext({}, crypto.randomUUID()),
    ).toMatchObject({ status: "working", work: { kind: "charge_hunt" } });
    for (const [index, found] of hunts.entries()) {
      const [persisted] = await getDb(ctx.db)
        .select()
        .from(importHunt)
        .where(eq(importHunt.id, found.hunt.id));
      expect(persisted?.state).toBe(states[index]);
    }
  });
  it("refuses contradictory retained Hunt claims instead of picking the latest amount", async () => {
    const { original, claim } = await fixture("charges");
    await claim(12.34);
    await claim(20);
    await expect(
      controlRun(ctx.db, ctx.actor, {
        runPublicId: original.shortcode,
        action: "retry",
      }),
    ).rejects.toThrow(/Historical charge.*conflicting/);
    expect(
      await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.predecessorRunId, original.id)),
    ).toEqual([]);
  });
  it("honors another unfinished historical charge owner while converting remaining selected Hunts", async () => {
    const { hunts, original } = await fixture("charges");
    const held = hunts.find(({ name }) => name === "unvisited")!;
    const { id: _id, shortcode: _shortcode, ...values } = original;
    const ownerId = runEntityId.parse(crypto.randomUUID());
    const owner = await insertWithShortcode(ctx.db, "run", {
      ...values,
      id: ownerId,
      clientKey: null,
      dispatchEventId: crypto.randomUUID(),
      agentSessionId: importRunAgentIdentity(ownerId, "account_sync"),
      input: { kind: "charge_hunts", huntIds: [held.hunt.id] },
      parentRunId: null,
      predecessorRunId: null,
    });
    const result = await controlRun(ctx.db, ctx.actor, {
      runPublicId: original.shortcode,
      action: "retry",
    });
    if (!("successorRunId" in result) || !result.successorRunId)
      throw new Error("Synthetic successor missing.");
    const [successor] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, runEntityId.parse(result.successorRunId)));
    expect(
      researchObjectivesRunInput
        .parse(successor?.input)
        .objectives.map((objective) =>
          objective.kind === "charge_hunt" ? objective.huntId : null,
        )
        .sort(),
    ).toEqual(
      hunts
        .filter(({ name }) => name !== "unvisited")
        .map(({ hunt }) => hunt.id)
        .sort(),
    );
    expect(
      await getDb(ctx.db).select().from(run).where(eq(run.id, owner.id)),
    ).toEqual([owner]);
  });
  it("validates the full historical Hunt selection before excluding allocated work", async () => {
    const { f, hunts, original } = await fixture("charges");
    const foreign = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic different financial owner",
      kind: "household",
    });
    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Synthetic different financial account",
      ledgerPartyId: foreign.id,
      identity: { kind: "credit_card", issuer: null, network: "visa" },
    });
    const settled = hunts.find(({ name }) => name === "settled")!;
    await getDb(ctx.db).insert(financialTransactionAllocation).values({
      transactionId: settled.transaction.id,
      purchaseId: f.order.id,
      amount: settled.transaction.amount,
    });
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ accountId: account.id })
      .where(eq(financialTransaction.id, settled.transaction.id));
    await expect(
      controlRun(ctx.db, ctx.actor, {
        runPublicId: original.shortcode,
        action: "retry",
      }),
    ).rejects.toThrow(/Historical charge.*ownership/);
    expect(
      await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.predecessorRunId, original.id)),
    ).toEqual([]);
  });
  it("refuses an unretained historical account boundary rather than substituting today's cursor", async () => {
    const { account, original } = await fixture("sync");
    await getDb(ctx.db)
      .update(vendorAccount)
      .set({
        cursor: {
          newestOrderAt: "2026-10-01T18:00:00Z",
          orderIdsOnNewestDate: [],
          backfillBeforeOrderAt: null,
          earliestAvailableOrderAt: null,
        },
      })
      .where(eq(vendorAccount.id, account.id));
    await expect(
      controlRun(ctx.db, ctx.actor, {
        runPublicId: original.shortcode,
        action: "retry",
      }),
    ).rejects.toThrow(/Historical account.*starting.*not retained/);
    expect(
      await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.predecessorRunId, original.id)),
    ).toEqual([]);
  });
});
