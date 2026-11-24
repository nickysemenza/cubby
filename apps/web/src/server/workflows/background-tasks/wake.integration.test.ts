import type { BackgroundTaskMessage } from "@cubby/schemas/queue-messages";
import { fromPartial } from "@total-typescript/shoehorn";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import { withTransactionDatabase } from "~/server/db/helpers";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { startPass } from "~/server/kernel/api";
import { productionKernel } from "~/server/kernel/kernel";
import { kernelNextSql } from "~/server/kernel/runner";

import { clearDeliveredWakes, offerWake, wakeAt } from "./publish";

// Duplicate and stale permits must not clone wake chains.
describe("single pending future wake", () => {
  const ctx = withTestDb();
  afterEach(() => setCfEnv(undefined));

  it("sends one permit per pending deadline, re-arms on its own delivery and ignores a past one", async () => {
    const sent: BackgroundTaskMessage[] = [];
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          sendBatch: async (
            messages: Iterable<{ body: BackgroundTaskMessage }>,
          ) => {
            for (const { body } of messages) sent.push(body);
          },
        },
      }),
    );
    const later = new Date(Date.now() + 10 * 60_000);
    const sooner = new Date(Date.now() + 5 * 60_000);

    // Two deliveries offering the same next deadline, and a later one.
    await offerWake(ctx.db, later, "synthetic.first");
    await offerWake(ctx.db, later, "synthetic.duplicate");
    await offerWake(
      ctx.db,
      new Date(later.getTime() + 60_000),
      "synthetic.late",
    );
    expect(sent.map((body) => body.at)).toEqual([later.toISOString()]);

    await offerWake(ctx.db, sooner, "synthetic.sooner");
    expect(sent.map((body) => body.at)).toEqual([
      later.toISOString(),
      sooner.toISOString(),
    ]);

    // The superseded permit leaves the pending one; the pending one's early
    // delivery clears it, so its deadline is offered again.
    await clearDeliveredWakes(ctx.db, [later.toISOString()]);
    await offerWake(ctx.db, sooner, "synthetic.stale");
    expect(sent).toHaveLength(2);
    await clearDeliveredWakes(ctx.db, [sooner.toISOString()]);
    await offerWake(ctx.db, sooner, "synthetic.early");
    expect(sent).toHaveLength(3);

    // A pending wake already past due (its permit lost) no longer blocks.
    await repositoryQueries(ctx.db).execute(
      sql`UPDATE "KernelWake" SET at = now() - interval '1 minute'`,
    );
    await offerWake(ctx.db, later, "synthetic.after-loss");
    expect(sent.at(-1)?.at).toBe(later.toISOString());

    // A deadline due before its writer commits sends nothing until the commit.
    const before = sent.length;
    await expect(
      withTransactionDatabase(ctx.db, async (tx) => {
        await wakeAt(new Date(Date.now() - 1), {
          source: "synthetic.rolled-back",
          db: tx,
        });
        expect(sent).toHaveLength(before);
        throw new Error("synthetic rollback");
      }),
    ).rejects.toThrow("synthetic rollback");
    expect(sent).toHaveLength(before);
  });

  it("offers no successor for due rows no runner claims", async () => {
    const sent: BackgroundTaskMessage[] = [];
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          sendBatch: async (
            messages: Iterable<{ body: BackgroundTaskMessage }>,
          ) => {
            for (const { body } of messages) sent.push(body);
          },
        },
      }),
    );
    const q = repositoryQueries(ctx.db);
    const next = async () =>
      (
        await q.execute<{ at: string | null }>(
          sql`SELECT (${kernelNextSql((await productionKernel()).registry)})::text AS at`,
        )
      ).rows[0]?.at ?? null;
    const before = await next();
    // An exhausted Pass, a hosted Ask and an externally executed Ask, all due.
    await q.execute(sql`
      INSERT INTO "Pass" (name, key, cursor, attempts, "maxAttempts", "availableAt")
      VALUES ('retention', 'synthetic-exhausted', '{}'::jsonb, 5, 5, now() - interval '1 hour')`);
    for (const [hash, feature, producer, executor, hosted] of [
      ["synthetic-hosted", "purchase.agent-turn", "model", null, true],
      ["synthetic-external", "image.device", "image", "external", false],
    ] as const)
      await q.execute(sql`
        WITH ask AS (
          INSERT INTO "Ask" ("inputHash", feature, producer, "promptVersion", input, "maxAttempts", executor, hosted, "availableAt")
          VALUES (${hash}, ${feature}, ${producer}, '1', '{}'::jsonb, 3, ${executor}, ${hosted}, now() - interval '1 hour')
          RETURNING id
        ) INSERT INTO "AskScope" ("askId", "scopeKind", "scopeKey") SELECT id, 'fields', ${hash} FROM ask`);
    expect(await next()).toBe(before);

    // Starting the exhausted Pass again leaves it unclaimable and sends nothing.
    await startPass(ctx.db, "retention", { key: "synthetic-exhausted" });
    expect(await next()).toBe(before);
    expect(sent).toEqual([]);
  });
});
