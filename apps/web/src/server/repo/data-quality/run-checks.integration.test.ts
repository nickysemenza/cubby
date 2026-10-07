import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { run as runTable, runTarget } from "~/server/db/schema";
import { loadRunDetail } from "~/server/purchase-import/run-service";
import { unwrapDb } from "~/server/repo/database-helpers";
import { listRunsRead } from "~/server/repo/run";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { loadDataQualities } from "./hydrate";
import { scoreSql, statusCondition } from "./sql";

// A complete outcome must not hide unfinished targets, missing skip reasons,
// or an impossible timeline. Active work and non-browser work remain valid.
describe("Run data quality", () => {
  const ctx = withTestDb();
  const start = new Date("2026-09-01T10:00:00Z");
  const end = new Date("2026-09-01T10:01:00Z");

  const makeRun = async (
    status: "running" | "completed",
    endedAt: Date | null = end,
  ) => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Fixture agent",
      kind: "guest",
    });
    return insertWithShortcode(ctx.db, "run", {
      ledgerPartyId: party.id,
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: party.kind,
      actorUserId: ctx.actor.userId,
      actorName: "Fixture agent",
      actorEmail: "agent@example.test",
      purpose: "product_enrichment",
      trigger: "manual",
      status,
      startedAt: start,
      endedAt,
    });
  };

  it("scores complete and honestly skipped targets without requiring a browser capture", async () => {
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Fixture packet",
      manufacturer: "Fixture Seeds",
    });
    const completed = await makeRun("completed");
    const skipped = await makeRun("completed");
    const active = await makeRun("running", null);
    await unwrapDb(ctx.db)
      .insert(runTarget)
      .values([
        {
          runId: completed.id,
          entityKind: "product",
          entityId: product.id,
          state: "completed",
          outcome: "enriched",
          completedAt: end,
          targetFingerprint: "a".repeat(64),
        },
        {
          runId: skipped.id,
          entityKind: "product",
          entityId: product.id,
          state: "skipped",
          outcome: "skipped",
          warning: "The source cannot distinguish this variant",
          completedAt: end,
          targetFingerprint: "b".repeat(64),
        },
        {
          runId: active.id,
          entityKind: "product",
          entityId: product.id,
          state: "pending",
          targetFingerprint: "c".repeat(64),
        },
      ]);
    const qualities = await loadDataQualities(ctx.db, "run", [
      completed.id,
      skipped.id,
      active.id,
    ]);
    for (const run of [completed, skipped, active])
      expect(qualities.get(run.id)).toMatchObject({
        score: 100,
        status: "complete",
        gaps: [],
      });
  });

  it("exposes invalid completion records through hydration and shared SQL filters", async () => {
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Fixture packet",
      manufacturer: "Fixture Seeds",
    });
    const unfinished = await makeRun("completed");
    const unexplained = await makeRun("completed");
    const empty = await makeRun("completed");
    const badClock = await makeRun("running", new Date("2026-09-01T09:59:00Z"));
    await unwrapDb(ctx.db)
      .insert(runTarget)
      .values([
        {
          runId: unfinished.id,
          entityKind: "product",
          entityId: product.id,
          state: "pending",
          targetFingerprint: "d".repeat(64),
        },
        {
          runId: unexplained.id,
          entityKind: "product",
          entityId: product.id,
          state: "skipped",
          outcome: "skipped",
          completedAt: end,
          targetFingerprint: "e".repeat(64),
        },
      ]);
    const qualities = await loadDataQualities(ctx.db, "run", [
      unfinished.id,
      unexplained.id,
      empty.id,
      badClock.id,
    ]);
    for (const run of [unfinished, unexplained, empty]) {
      expect(qualities.get(run.id)?.gaps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ check: "run_target_outcomes" }),
        ]),
      );
      expect(qualities.get(run.id)?.score).toBeLessThan(100);
    }
    expect(qualities.get(badClock.id)?.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "run_timeline" }),
      ]),
    );
    expect(qualities.get(badClock.id)?.status).toBe("defect");
    const filtered = await unwrapDb(ctx.db)
      .select({ id: runTable.id, score: scoreSql("run", runTable) })
      .from(runTable)
      .where(statusCondition("run", "defect", runTable));
    expect(filtered.map((row) => row.id)).toEqual(
      expect.arrayContaining([unfinished.id, badClock.id]),
    );
    expect(
      Number(filtered.find((row) => row.id === unfinished.id)?.score),
    ).toBe(qualities.get(unfinished.id)?.score);
  });
  it("projects the target account's human label rather than its identifier", async () => {
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Fixture packet",
      manufacturer: "Fixture Seeds",
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Fixture vendor",
    });
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Fixture owner",
      kind: "guest",
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: vendor.id,
      ledgerPartyId: party.id,
      label: "Fixture store login",
    });
    const run = await makeRun("completed");
    await unwrapDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: run.id,
        vendorAccountId: account.id,
        entityKind: "product",
        entityId: product.id,
        state: "completed",
        outcome: "enriched",
        completedAt: end,
        targetFingerprint: "f".repeat(64),
      });
    expect(
      (await loadRunDetail(ctx.db, run.shortcode)).targets[0]
        ?.vendorAccountLabel,
    ).toBe(account.label);
  });
  it("delivers quality through the progressive enrichment projection", async () => {
    const run = await makeRun("running", null);
    const args = [{}, [], { pageIndex: 0, pageSize: 50 }] as const;
    const base = await listRunsRead(ctx.db, args[0], [...args[1]], args[2], {
      kind: "base",
    });
    const enriched = await listRunsRead(
      ctx.db,
      args[0],
      [...args[1]],
      args[2],
      { kind: "enrichment", groups: ["quality"] },
    );
    expect(
      base.data.find((row) => row.id === run.shortcode)?.dataQuality,
    ).toBeUndefined();
    expect(
      enriched.data.find((row) => row.id === run.shortcode)?.dataQuality,
    ).toMatchObject({ score: 100, status: "complete" });
  });
});
