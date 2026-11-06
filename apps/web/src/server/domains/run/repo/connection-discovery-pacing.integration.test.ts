import { and, eq, inArray } from "drizzle-orm";
import { createRepoIdentity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { aiEvaluation, task } from "~/server/db/schema";
import { connectionDiscoveryPage } from "~/server/domains/run/repo/derived-discovery";
import { connectionDiscoveryDrain } from "~/server/domains/run/service/derived-discovery";

import { stopAutomaticAi } from "./automatic-ai-stop";
import {
  CONNECTION_DISCOVERY_PENDING_CAP,
  pendingConnectionEvaluations,
  admitConnectionDiscoveryPage,
} from "./connection-refresh";

async function connectionEvaluations(db: Database, recordId: string) {
  const rows = await getDb(db)
    .select({
      id: aiEvaluation.id,
      state: aiEvaluation.state,
      target: aiEvaluation.target,
    })
    .from(aiEvaluation)
    .where(eq(aiEvaluation.feature, "entity-connections"));
  return rows.filter(
    (row) =>
      typeof row.target === "object" &&
      row.target !== null &&
      "recordId" in row.target &&
      row.target.recordId === recordId,
  );
}

describe("connection discovery pacing", () => {
  const ctx = withTestDb();

  async function tasks(names: string[]) {
    await activateAiRefresh(ctx.db, "synthetic-discovery-pacing", {
      enabled: true,
    });
    const created = [];
    for (const name of names)
      created.push(
        await createRepoIdentity(ctx, "task", { name, trade: "other" }),
      );
    return created;
  }

  it("walks the newest records first and covers each exactly once", async () => {
    const created = await tasks(["Older task", "Middle task", "Newest task"]);
    let after: string | null = null;
    let pages = 0;
    do {
      const result: Awaited<ReturnType<typeof admitConnectionDiscoveryPage>> =
        await admitConnectionDiscoveryPage(ctx.db, {
          after,
          limit: 2,
          entityKinds: ["task"],
          newestFirst: true,
        });
      if (result.held) throw new Error("Synthetic discovery page was held");
      after = result.next;
      pages += 1;
    } while (after && pages < 5);
    const evaluated = await getDb(ctx.db)
      .select({ target: aiEvaluation.target })
      .from(aiEvaluation)
      .where(eq(aiEvaluation.feature, "entity-connections"))
      .orderBy(aiEvaluation.createdAt);
    const recordIds = await Promise.all(
      created.map(async (item) => {
        const [row] = await getDb(ctx.db)
          .select({ id: task.id })
          .from(task)
          .where(eq(task.shortcode, item.output.id));
        return row!.id;
      }),
    );
    expect(
      evaluated.map((row) => (row.target as { recordId: string }).recordId),
    ).toEqual([...recordIds].reverse());
  });

  it("updates a changed record's queued evaluation without cancelling its Job", async () => {
    const [created] = await tasks(["Synthetic replaceable task"]);
    const page = () =>
      admitConnectionDiscoveryPage(ctx.db, {
        after: null,
        limit: 25,
        entityKinds: ["task"],
        newestFirst: true,
      });
    await page();
    const [row] = await getDb(ctx.db)
      .select({ id: task.id })
      .from(task)
      .where(eq(task.shortcode, created!.output.id));
    await getDb(ctx.db)
      .update(task)
      .set({ name: "Synthetic replaceable task, renamed" })
      .where(eq(task.id, row!.id));
    await page();
    const states = (await connectionEvaluations(ctx.db, row!.id)).map(
      (item) => item.state,
    );
    expect(states).toEqual(["queued"]);
  });

  it("updates the queued slot when input reverts before execution", async () => {
    const [created] = await tasks(["Synthetic reverting task"]);
    const [row] = await getDb(ctx.db)
      .select({ id: task.id })
      .from(task)
      .where(eq(task.shortcode, created!.output.id));
    const page = () =>
      admitConnectionDiscoveryPage(ctx.db, {
        after: null,
        limit: 25,
        entityKinds: ["task"],
        newestFirst: true,
      });
    const rename = (name: string) =>
      getDb(ctx.db).update(task).set({ name }).where(eq(task.id, row!.id));
    await page(); // fingerprint A queued
    await rename("Synthetic reverting task, edited");
    await page(); // queued slot now captures B
    await rename("Synthetic reverting task");
    await page(); // the same queued slot captures A again
    const states = (await connectionEvaluations(ctx.db, row!.id)).map(
      (item) => item.state,
    );
    expect(states.filter((state) => state === "queued")).toHaveLength(1);
    expect(states).toEqual(["queued"]);
  });

  it("holds its cursor while a member's Stop stands", async () => {
    await tasks(["Synthetic stopped task"]);
    await stopAutomaticAi(ctx.db, ctx.actor);
    await connectionDiscoveryPage(ctx.db, async (_tx, cursor, save) =>
      save({ ...cursor, after: "synthetic-cursor" }),
    );
    const page = await connectionDiscoveryDrain.page(ctx.db, {
      deadline: Date.now() + 20_000,
    });
    expect(page.more).toBe(false);
    const cursor = await connectionDiscoveryPage(
      ctx.db,
      async (_tx, cursor) => cursor,
    );
    expect(cursor.after).toBe("synthetic-cursor");
    expect(await pendingConnectionEvaluations(ctx.db)).toBe(0);
  });

  it("holds its cursor while the evaluation backlog is at the cap", async () => {
    await tasks(["Synthetic backpressure task"]);
    await getDb(ctx.db)
      .insert(aiEvaluation)
      .values(
        Array.from(
          { length: CONNECTION_DISCOVERY_PENDING_CAP },
          (_, index) => ({
            workKey: `synthetic-backlog-${index}`,
            feature: "entity-connections",
            target: {
              kind: "connection" as const,
              entity: "task" as const,
              recordId: crypto.randomUUID(),
              field: null,
              suggestionIds: [],
            },
            provenance: {
              dependencies: [],
              inputFingerprint: `synthetic-backlog-${index}`,
              optionFingerprint: "synthetic",
              model: null,
            },
            snapshot: {},
            state: "queued" as const,
            executionKind: "ai_refresh" as const,
          }),
        ),
      );
    expect(await pendingConnectionEvaluations(ctx.db)).toBe(
      CONNECTION_DISCOVERY_PENDING_CAP,
    );
    await connectionDiscoveryPage(ctx.db, async (_tx, cursor, save) =>
      save({ ...cursor, after: "synthetic-cursor" }),
    );
    const page = await connectionDiscoveryDrain.page(ctx.db, {
      deadline: Date.now() + 20_000,
    });
    expect(page.more).toBe(false);
    const cursor = await connectionDiscoveryPage(
      ctx.db,
      async (_tx, cursor) => cursor,
    );
    expect(cursor.after).toBe("synthetic-cursor");
    expect(cursor.nextAt).toBe(page.nextAt?.toISOString());
    const admitted = await getDb(ctx.db)
      .select({ id: aiEvaluation.id })
      .from(aiEvaluation)
      .where(
        and(
          eq(aiEvaluation.feature, "entity-connections"),
          inArray(aiEvaluation.state, ["queued"]),
        ),
      );
    expect(admitted).toHaveLength(CONNECTION_DISCOVERY_PENDING_CAP);
    expect(page.nextAt?.getTime()).toBeGreaterThan(Date.now() + 110_000);
    expect(page.nextAt?.getTime()).toBeLessThanOrEqual(Date.now() + 120_000);
  });
});
