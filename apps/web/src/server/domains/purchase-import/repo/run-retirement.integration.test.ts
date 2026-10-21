/**
 * Coordinator retirement: a settled agent Run's transcript is destroyed, and
 * `Run.retiredAt` is stamped only once a cold coordinator reports empty
 * storage — an isolate interruption is not a deletion receipt. A retired
 * coordinator never executes again, and a late in-flight result never
 * repopulates the erased content.
 */
import { type LedgerPartyId, runEntityId } from "@cubby/schemas/identifiers";
import { importRunAgentIdentity } from "@cubby/schemas/import-run-agent";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { run, runOperation, runFinding } from "~/server/db/schema";
import {
  executeAtomicOperation,
  executeLeasedOperation,
} from "~/server/domains/run/repo/operation";
import { findOpenRunFindings } from "~/server/generic/problems/repo/detectors-import";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { startAgentRunFixture } from "../service/import-run.fixtures";
import {
  assertRetirableLegacySession,
  assertRetirableRun,
  coordinatorRetired,
  retireSettledCoordinators,
} from "./run-retirement";

const ctx = withTestDb();

// One member party per actor; each test's database starts without it.
let member: { id: LedgerPartyId } | undefined;
beforeEach(() => {
  member = undefined;
});
async function agentRun() {
  member ??= await insertWithShortcode(ctx.db, "ledgerParty", {
    name: "Synthetic coordinator owner",
    kind: "member",
    userId: ctx.actor.userId,
  });
  const started = await startAgentRunFixture(ctx.db, {
    ledgerPartyId: member.id,
  });
  return runEntityId.parse(started.id);
}

const settle = (runId: string, updatedAt = new Date(Date.now() - 60_000)) =>
  getDb(ctx.db)
    .update(run)
    .set({ status: "completed", updatedAt })
    .where(eq(run.id, runEntityId.parse(runId)));

const retire = (runId: string) =>
  getDb(ctx.db)
    .update(run)
    .set({ retiredAt: new Date(), retirementReason: "settled" })
    .where(eq(run.id, runEntityId.parse(runId)));

// A Run of a retired purpose keeps its original coordinator identity.
const retirePurpose = (runId: string) =>
  getDb(ctx.db)
    .update(run)
    .set({ purpose: "product_enrichment" })
    .where(eq(run.id, runEntityId.parse(runId)));

// Legacy account_sync Runs stored a bare session UUID, not their Run id, as
// the coordinator name.
const legacySession = (runId: string, agentSessionId = crypto.randomUUID()) =>
  getDb(ctx.db)
    .update(run)
    .set({ purpose: "account_sync", agentSessionId })
    .where(eq(run.id, runEntityId.parse(runId)))
    .then(() => agentSessionId);

const readRun = async (runId: string) => {
  const [row] = await getDb(ctx.db)
    .select()
    .from(run)
    .where(eq(run.id, runEntityId.parse(runId)));
  return row;
};

describe("settled coordinator retirement", () => {
  // Obsolete execution alerts must close for both new and historical retirements;
  // source review and live coordinator alerts must retain their evidence and status.
  it("dismisses only obsolete execution alerts on new and existing retired Runs", async () => {
    const historical = await agentRun();
    await settle(historical);
    await retire(historical);
    const newlySettled = await agentRun();
    await settle(newlySettled);
    const live = await agentRun();
    const owner = (await readRun(historical))!.ledgerPartyId!;
    const findings = [];
    for (const runId of [historical, newlySettled, live]) {
      for (const [index, summary] of [
        "No coordinator activity for two hours",
        "Coordinator ended without finishing the run",
        "Synthetic source still needs review",
      ].entries()) {
        findings.push({
          runId,
          entityId: runId,
          entityKind: "run" as const,
          ledgerPartyId: owner,
          kind: "other",
          summary,
          evidenceFingerprint: `synthetic-${runId}-${index}`,
        });
      }
    }
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic retained review product",
      manufacturer: "Synthetic maker",
    });
    await getDb(ctx.db)
      .insert(runFinding)
      .values([
        ...findings,
        {
          runId: historical,
          entityId: product.id,
          entityKind: "product",
          ledgerPartyId: owner,
          kind: "other",
          summary: "No coordinator activity for two hours",
          evidenceFingerprint: "synthetic-product-review",
        },
        {
          runId: historical,
          entityId: newlySettled,
          entityKind: "run",
          ledgerPartyId: owner,
          kind: "other",
          summary: "Coordinator ended without finishing the run",
          evidenceFingerprint: "synthetic-other-run-review",
        },
      ]);
    const before = await getDb(ctx.db).select().from(runFinding);
    const visible = await findOpenRunFindings(ctx.db);
    expect(visible.map((row) => row.id).sort()).toEqual(
      before
        .filter(
          (row) =>
            !(
              row.runId === historical &&
              row.entityKind === "run" &&
              row.entityId === row.runId &&
              row.summary !== "Synthetic source still needs review"
            ),
        )
        .map((row) => row.id)
        .sort(),
    );
    await retireSettledCoordinators(
      ctx.db,
      () => ({ retire: async () => ({ disposed: true }) }),
      new Date(),
    );
    const after = await getDb(ctx.db).select().from(runFinding);
    expect(after).toHaveLength(before.length);
    const obsolete = (original: (typeof before)[number]) =>
      original.runId !== live &&
      original.entityKind === "run" &&
      original.entityId === original.runId &&
      original.summary !== "Synthetic source still needs review";
    for (const original of before.filter(obsolete))
      expect(after.find((row) => row.id === original.id)).toEqual({
        ...original,
        status: "dismissed",
        resolvedAt: expect.any(Date),
        updatedAt: expect.any(Date),
      });
    for (const original of before.filter((row) => !obsolete(row)))
      expect(after.find((row) => row.id === original.id)).toEqual(original);
    expect((await readRun(live))!.retiredAt).toBeNull();
  });

  it("retires only settled agent Runs, stamping retiredAt only after the coordinator acknowledges disposal", async () => {
    const live = await agentRun();
    const settled = await agentRun();
    await settle(settled);
    const fresh = await agentRun();
    await settle(fresh, new Date());
    const calls: string[] = [];
    let disposed = false;
    const coordinator = (agentId: string) => ({
      retire: async () => {
        calls.push(agentId);
        return { disposed };
      },
    });
    const before = new Date(Date.now() - 1_000);

    // The first call destroys the transcript and one follow-up asks for the
    // empty-inventory proof; without it nothing is stamped yet.
    expect(
      await retireSettledCoordinators(ctx.db, coordinator, before),
    ).toEqual({ considered: 1, retired: 0 });
    const settledAgent = importRunAgentIdentity(settled, "mail_import");
    expect(calls).toEqual([settledAgent, settledAgent]);
    expect(await coordinatorRetired(ctx.db, settled)).toBe(false);

    disposed = true;
    expect(
      await retireSettledCoordinators(ctx.db, coordinator, before),
    ).toEqual({ considered: 1, retired: 1 });
    expect(await readRun(settled)).toMatchObject({
      retirementReason: "settled",
      retiredAt: expect.any(Date),
    });
    expect(await coordinatorRetired(ctx.db, settled)).toBe(true);
    // A retired Run is never offered to its coordinator again.
    expect(
      await retireSettledCoordinators(ctx.db, coordinator, before),
    ).toEqual({ considered: 0, retired: 0 });
    for (const untouched of [live, fresh]) {
      expect(await coordinatorRetired(ctx.db, untouched)).toBe(false);
    }
  });

  it("offers a settled Run of a retired purpose by its stored coordinator identity", async () => {
    const historical = await agentRun();
    await retirePurpose(historical);
    await settle(historical);
    const calls: string[] = [];
    const coordinator = (agentId: string) => ({
      retire: async () => {
        calls.push(agentId);
        return { disposed: true };
      },
    });
    expect(
      await retireSettledCoordinators(
        ctx.db,
        coordinator,
        new Date(Date.now() - 1_000),
      ),
    ).toEqual({ considered: 1, retired: 1 });
    expect(calls).toEqual([importRunAgentIdentity(historical, "mail_import")]);
    expect(await coordinatorRetired(ctx.db, historical)).toBe(true);
  });

  // Regression: 25 unordered Runs per daily pass, each needing a second pass
  // for its acknowledgement, left a production backlog of months.
  it("retires a backlog oldest first in one pass, confirming each disposal immediately", async () => {
    const runs = [];
    for (let index = 0; index < 30; index += 1) runs.push(await agentRun());
    // Settled newest first, so storage order differs from age order.
    for (const [index, runId] of runs.entries())
      await settle(runId, new Date(Date.now() - 60_000 * (index + 1)));
    const oldestFirst = [...runs].reverse();
    // Real semantics: the destroying call reports disposed=false; a fresh
    // call then sees only the fence and acknowledges.
    const destroyed = new Set<string>();
    const calls: string[] = [];
    const coordinator = (agentId: string) => ({
      retire: async () => {
        calls.push(agentId);
        if (destroyed.has(agentId)) return { disposed: true };
        destroyed.add(agentId);
        return { disposed: false };
      },
    });
    const before = new Date(Date.now() - 1_000);

    expect(
      await retireSettledCoordinators(ctx.db, coordinator, before, 2),
    ).toEqual({ considered: 2, retired: 2 });
    expect([...new Set(calls)]).toEqual(
      oldestFirst
        .slice(0, 2)
        .map((runId) => importRunAgentIdentity(runId, "mail_import")),
    );

    expect(
      await retireSettledCoordinators(ctx.db, coordinator, before),
    ).toEqual({ considered: 28, retired: 28 });
    for (const runId of runs)
      expect(await coordinatorRetired(ctx.db, runId)).toBe(true);
  });

  // Oldest-first ordering would let one failing coordinator stall every pass.
  it("keeps retiring after one coordinator fails, then reports the failure", async () => {
    const failing = await agentRun();
    const healthy = await agentRun();
    await settle(failing, new Date(Date.now() - 120_000));
    await settle(healthy);
    const failingAgent = importRunAgentIdentity(failing, "mail_import");
    const coordinator = (agentId: string) => ({
      retire: async () => {
        if (agentId === failingAgent)
          throw new Error("Synthetic coordinator failure");
        return { disposed: true };
      },
    });
    await expect(
      retireSettledCoordinators(
        ctx.db,
        coordinator,
        new Date(Date.now() - 1_000),
      ),
    ).rejects.toThrow("Synthetic coordinator failure");
    expect(await coordinatorRetired(ctx.db, healthy)).toBe(true);
    expect(await coordinatorRetired(ctx.db, failing)).toBe(false);
  });

  it("authorizes coordinator disposal only for a settled Run", async () => {
    const live = await agentRun();
    await expect(assertRetirableRun(ctx.db, live)).rejects.toThrow(
      "Only a settled Run's coordinator can be retired.",
    );
    await expect(
      assertRetirableRun(ctx.db, crypto.randomUUID()),
    ).rejects.toThrow("Only a settled Run's coordinator can be retired.");
    await settle(live);
    await expect(assertRetirableRun(ctx.db, live)).resolves.toEqual({
      current: true,
    });
    // A missing Run reads as retired, so no coordinator executes for it.
    expect(await coordinatorRetired(ctx.db, crypto.randomUUID())).toBe(true);
  });

  it("authorizes a legacy coordinator name only for the one settled Run storing it", async () => {
    const legacy = await agentRun();
    const agentId = await legacySession(legacy);
    const refused =
      "Only one settled Run storing this coordinator name can retire it.";
    // Live mapping.
    await expect(assertRetirableLegacySession(ctx.db, agentId)).rejects.toThrow(
      refused,
    );
    await settle(legacy);
    await expect(
      assertRetirableLegacySession(ctx.db, agentId),
    ).resolves.toBeUndefined();
    // Missing mapping, and the Run id itself is not the stored name.
    for (const name of [crypto.randomUUID(), legacy])
      await expect(assertRetirableLegacySession(ctx.db, name)).rejects.toThrow(
        refused,
      );
    // Ambiguous mapping.
    const twin = await agentRun();
    await legacySession(twin, agentId);
    await settle(twin);
    await expect(assertRetirableLegacySession(ctx.db, agentId)).rejects.toThrow(
      refused,
    );
    // A current purpose is always addressed by its import Run identity.
    const current = await agentRun();
    await settle(current);
    const currentName = crypto.randomUUID();
    await getDb(ctx.db)
      .update(run)
      .set({ agentSessionId: currentName })
      .where(eq(run.id, current));
    await expect(
      assertRetirableLegacySession(ctx.db, currentName),
    ).rejects.toThrow(refused);
  });
});

// Retirement can commit while a tool call is in flight. Its late completion or
// failure must not repopulate disposable source content.
describe("retired coordinator operation fence", () => {
  it("rejects a late leased result instead of caching erased source content", async () => {
    const runId = await agentRun();
    await expect(
      executeLeasedOperation(
        ctx.db,
        {
          runId,
          operationId: "synthetic-in-flight-read",
          kind: "mail_read",
          payload: {},
        },
        async () => {
          await retire(runId);
          return { text: "Synthetic private source" };
        },
      ),
    ).rejects.toThrow(/retired/i);
    const rows = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .where(eq(runOperation.runId, runId));
    expect(rows.every((row) => row.result === null)).toBe(true);
  });

  it("refuses a new tool call and does not record a failed attempt after retirement", async () => {
    const runId = await agentRun();
    await expect(
      executeAtomicOperation(
        ctx.db,
        {
          runId,
          operationId: "synthetic-in-flight-write",
          kind: "purchase_commit",
          payload: { detail: "Synthetic private source" },
          subject: "Commit",
          recordFailure: true,
          retainAttempt: true,
        },
        async () => {
          await retire(runId);
          throw new Error("Synthetic write interrupted");
        },
      ),
    ).rejects.toThrow("Synthetic write interrupted");
    await expect(
      executeLeasedOperation(
        ctx.db,
        {
          runId,
          operationId: "synthetic-late-call",
          kind: "mail_read",
          payload: {},
        },
        async () => ({ text: "Synthetic private source" }),
      ),
    ).rejects.toThrow(/retired/i);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runOperation)
        .where(eq(runOperation.runId, runId)),
    ).toEqual([]);
  });
});
