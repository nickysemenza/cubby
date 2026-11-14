import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { repositoryQueries } from "~/server/db/repository-access.boundary";

import {
  defineAsk,
  createKernel,
  defineModule,
  definePass,
  evidenceRow,
} from "./api";
import {
  queueAsk,
  claimExternalAsk,
  renewExternalAsk,
  releaseExternalAsk,
  cancelExternalAsk,
  settleExternalAsk,
  expireAsks,
} from "./ask";
import { nextWakeSql, claimAsk, claimPass, releaseClaim } from "./claim";
import {
  fixtureModule,
  chargeEvidence,
  fixtureCharge,
  resetFixtureTables,
} from "./testing/kernel.fixtures";

const kind = defineAsk({
  feature: "synthetic.device",
  producer: "image",
  promptVersion: "1",
  input: z.object({ revision: z.string() }),
  output: z.object({ value: z.string() }),
});

describe("external Ask lifecycle", () => {
  const ctx = withTestDb();
  it("fences named executors, retains unknown late claims, replays once, and appends atomically", async () => {
    await resetFixtureTables(ctx.db);
    const kernel = createKernel([
      fixtureModule().module,
      defineModule({ name: "device", asks: [kind] }),
    ]);
    const id = await queueAsk(
      ctx.db,
      kind,
      { revision: "original" },
      { record: { entity: "image", id: crypto.randomUUID() } },
    );
    const next = await repositoryQueries(ctx.db).execute<{
      wake: string | null;
    }>(sql`SELECT ${nextWakeSql()} AS wake`);
    expect(next.rows[0]?.wake).toBeNull();
    const claim = await claimExternalAsk(ctx.db, kind, {
      id,
      executor: "synthetic-device",
      leaseMs: 60000,
    });
    if (!claim) throw new Error("Expected device claim");
    expect(
      await claimExternalAsk(ctx.db, kind, {
        id,
        executor: "another-device",
        leaseMs: 60000,
      }),
    ).toBeNull();
    expect(
      await renewExternalAsk(ctx.db, { ...claim, executor: "another-device" }),
    ).toBeNull();
    expect(await renewExternalAsk(ctx.db, claim)).toBeInstanceOf(Date);
    await repositoryQueries(ctx.db).execute(
      sql`UPDATE "Ask" SET "claimDeadline"=now()-interval '1 minute' WHERE id=${id}::uuid`,
    );
    await expireAsks(ctx.db, kernel.registry);
    const settle = () =>
      settleExternalAsk(
        ctx.db,
        kernel.registry,
        kind,
        claim,
        { output: { value: "result" } },
        {
          validate: async () => true,
          evidence: async () => [
            evidenceRow(chargeEvidence, {
              sourceRef: "synthetic-device-result",
              orderRef: "synthetic-order",
              amountMinor: 100,
            }),
          ],
        },
      );
    expect(await settle()).toMatchObject({ status: "settled" });
    expect(await settle()).toMatchObject({
      status: "replayed",
      output: { value: "result" },
    });
    expect(
      await repositoryQueries(ctx.db).select().from(fixtureCharge),
    ).toHaveLength(1);
  });
  it("shares partition slots with Passes and inline Asks under concurrent external claims", async () => {
    await resetFixtureTables(ctx.db);
    const claimLimit = { partition: "synthetic-image-executors", slots: 1 };
    const limited = defineAsk({ ...kind, claimLimit });
    const pass = definePass({
      name: "synthetic.image-pass",
      claimLimit,
      async run() {
        return { cursor: null, done: true };
      },
    });
    const kernel = createKernel([
      fixtureModule().module,
      defineModule({ name: "device", asks: [limited], passes: [pass] }),
    ]);
    await kernel.startPass(ctx.db, pass);
    const held = await claimPass(ctx.db, [pass]);
    if (!held) throw new Error("Expected Pass claim");
    const ids = await Promise.all(
      ["one", "two", "three"].map((revision) =>
        queueAsk(ctx.db, limited, { revision }),
      ),
    );
    const claim = (id: string) =>
      claimExternalAsk(ctx.db, limited, {
        id,
        executor: "synthetic-device",
        leaseMs: 60000,
      });
    expect(await claim(ids[0]!)).toBeNull();
    await releaseClaim(
      repositoryQueries(ctx.db),
      { table: "Pass", name: pass.name, key: "default" },
      held.token,
    );
    await repositoryQueries(ctx.db).execute(
      sql`UPDATE "Ask" SET "availableAt"=now()`,
    );
    const claims = await Promise.all(ids.slice(0, 2).map(claim));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const owned = claims.find((entry) => entry !== null);
    if (!owned) throw new Error("Expected one external claim");
    expect(await claimAsk(ctx.db, ids[2]!, claimLimit)).toBeNull();
    expect(await releaseExternalAsk(ctx.db, owned)).toBe(true);
    await repositoryQueries(ctx.db).execute(
      sql`UPDATE "Ask" SET "availableAt"=now()`,
    );
    expect(await claimAsk(ctx.db, ids[2]!, claimLimit)).not.toBeNull();
    expect(await claim(ids[0]!)).toBeNull();
    const state = await repositoryQueries(ctx.db).execute<{ attempts: number }>(
      sql`SELECT attempts FROM "Ask"`,
    );
    expect(state.rows.every((row) => row.attempts === 0)).toBe(true);
  });
  it("release permits a fresh token, cancellation and changed source refuse settlement", async () => {
    await resetFixtureTables(ctx.db);
    const kernel = createKernel([
      fixtureModule().module,
      defineModule({ name: "device", asks: [kind] }),
    ]);
    const id = await queueAsk(ctx.db, kind, { revision: "replacement" });
    const first = await claimExternalAsk(ctx.db, kind, {
      id,
      executor: "synthetic-device",
      leaseMs: 60000,
    });
    if (!first) throw new Error("Expected claim");
    expect(await releaseExternalAsk(ctx.db, first)).toBe(true);
    const next = await claimExternalAsk(ctx.db, kind, {
      id,
      executor: "synthetic-device",
      leaseMs: 60000,
    });
    if (!next) throw new Error("Expected replacement claim");
    const settle = (claim: typeof next, valid: boolean) =>
      settleExternalAsk(
        ctx.db,
        kernel.registry,
        kind,
        claim,
        { output: { value: "result" } },
        { validate: async () => valid, evidence: async () => [] },
      );
    expect(await settle(first, true)).toEqual({ status: "refused" });
    expect(await settle(next, false)).toEqual({ status: "refused" });
    await cancelExternalAsk(ctx.db, id);
    expect(await settle(next, true)).toEqual({ status: "refused" });
  });
});
