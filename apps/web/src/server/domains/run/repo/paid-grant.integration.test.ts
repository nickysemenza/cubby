import { runEntityId, type RunId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { run, runControlEvent } from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { ensureRun } from "./ensure-run";
import { readPaidGrant, recordPaidGrant } from "./paid-grant";

describe("fresh paid grant lineage reads", () => {
  const ctx = withTestDb();
  beforeEach(async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic grant member",
      kind: "member",
      userId: ctx.actor.userId,
    });
  });
  const create = () => ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
  const grant = async (runId: RunId, amount: number, order: number) => {
    await recordPaidGrant(ctx.db, ctx.actor, {
      runId,
      paidOverBudgetUsd: amount,
    });
    await getDb(ctx.db)
      .update(runControlEvent)
      .set({
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, order)),
      })
      .where(eq(runControlEvent.runId, runId));
  };

  it("reads a fresh grant in one query for each admission", async () => {
    const runId = await create();
    await grant(runId, 1, 1);
    const measured = await countTestDbQueries(() =>
      Promise.all(
        Array.from({ length: 32 }, () => readPaidGrant(ctx.db, runId)),
      ),
    );
    expect(
      measured.result.every((value) => value?.paidOverBudgetUsd === 1),
    ).toBe(true);
    expect(measured.queryCount).toBe(32);
    await recordPaidGrant(ctx.db, ctx.actor, { runId, paidOverBudgetUsd: 2 });
    expect(await readPaidGrant(ctx.db, runId)).toMatchObject({
      paidOverBudgetUsd: 2,
    });
    expect(
      await readPaidGrant(ctx.db, runEntityId.parse(crypto.randomUUID())),
    ).toBeNull();
  });

  it("includes each predecessor's direct parent without following parent ancestry or cycles", async () => {
    const [current, predecessor, parent, ancestor, unrelated] =
      await Promise.all(Array.from({ length: 5 }, create));
    await getDb(ctx.db)
      .update(run)
      .set({ predecessorRunId: predecessor! })
      .where(eq(run.id, current!));
    await getDb(ctx.db)
      .update(run)
      .set({ predecessorRunId: current!, parentRunId: parent! })
      .where(eq(run.id, predecessor!));
    await getDb(ctx.db)
      .update(run)
      .set({ parentRunId: ancestor! })
      .where(eq(run.id, parent!));
    await grant(current!, 1, 1);
    await grant(predecessor!, 2, 2);
    await grant(parent!, 3, 3);
    await grant(ancestor!, 4, 4);
    await grant(unrelated!, 5, 5);
    expect(await readPaidGrant(ctx.db, current!)).toMatchObject({
      paidOverBudgetUsd: 3,
    });
  });

  it.each([false, true])(
    "stops before a predecessor already included as a parent (earlier ancestor: %s)",
    async (earlier) => {
      const [current, middle, parent, ancestor] = await Promise.all(
        Array.from({ length: 4 }, create),
      );
      await getDb(ctx.db)
        .update(run)
        .set({
          parentRunId: parent!,
          predecessorRunId: earlier ? middle! : parent!,
        })
        .where(eq(run.id, current!));
      await getDb(ctx.db)
        .update(run)
        .set({ predecessorRunId: parent! })
        .where(eq(run.id, middle!));
      await getDb(ctx.db)
        .update(run)
        .set({ parentRunId: ancestor! })
        .where(eq(run.id, parent!));
      await grant(current!, 1, 1);
      await grant(parent!, 2, 2);
      await grant(ancestor!, 3, 3);
      expect(await readPaidGrant(ctx.db, current!)).toMatchObject({
        paidOverBudgetUsd: 2,
      });
    },
  );

  it("retains the fifty-Run traversal boundary", async () => {
    const ids: RunId[] = [];
    for (let index = 0; index < 51; index++) ids.push(await create());
    for (let index = 0; index < ids.length - 1; index++)
      await getDb(ctx.db)
        .update(run)
        .set({ predecessorRunId: ids[index + 1]! })
        .where(eq(run.id, ids[index]!));
    await grant(ids[49]!, 1, 1);
    await grant(ids[50]!, 2, 2);
    const measured = await countTestDbQueries(() =>
      readPaidGrant(ctx.db, ids[0]!),
    );
    expect(measured.result).toMatchObject({ paidOverBudgetUsd: 1 });
    expect(measured.queryCount).toBe(1);
  });
});
