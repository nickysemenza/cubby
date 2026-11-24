import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { receivedGatewayResponse } from "~/server/ai/gateway-egress-client";
import {
  repositoryQueries,
  repositoryTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { findPgError } from "~/server/errors/db-errors";
import { admitHouseholdGate } from "~/server/kernel/gate";

import { runAgentTurn } from "./agent-turn-ask";

describe("agent model turn", () => {
  const ctx = withTestDb();
  const turnState = async (generation: string) =>
    (
      await repositoryQueries(ctx.db).execute<{
        state: string;
        attempts: number;
        token: string | null;
        answers: number;
      }>(sql`
        SELECT a.state, a.attempts, a."claimToken" AS token,
          (SELECT count(*)::int FROM "Answer" r WHERE r."inputHash" = a."inputHash") AS answers
        FROM "Ask" a WHERE a.input->${"input"}->>${"generation"} = ${generation}`)
    ).rows;
  const gateWaiters = async () =>
    (
      await repositoryQueries(ctx.db).execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
          AND objid = (hashtextextended('cubby:household-write', 0) & 4294967295)::oid`)
    ).rows[0]!.n;
  const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
  /**
   * Another writer takes the household gate and holds it until the first
   * publication attempt's lock wait gives up, then lets any later one in.
   */
  const holdGate = async () => {
    const locked = Promise.withResolvers<void>();
    const holder = repositoryTransactionDatabase(ctx.db, async (tx) => {
      await admitHouseholdGate(repositoryQueries(tx));
      locked.resolve();
      while (!(await gateWaiters())) await pause();
      while (await gateWaiters()) await pause();
    });
    await locked.promise;
    return { holder };
  };

  it("stores no Answer for a failed response and re-queues a refusal made before sending", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
    });
    const turn = async (generation: string, send: () => Promise<Response>) => {
      const response = await runAgentTurn(
        ctx.db,
        { runId, generation, request: { turn: 1 } },
        send,
        async () => {},
      );
      const ask = await repositoryQueries(ctx.db).execute<{
        state: string;
        answers: number;
      }>(sql`SELECT DISTINCT a.state, (SELECT count(*)::int FROM "Answer" r WHERE r."inputHash" = a."inputHash") AS answers
        FROM "Ask" a WHERE a.input->${"input"}->>${"generation"} = ${generation}`);
      return { status: response.status, ask: ask.rows };
    };
    // The provider answered after the request left: the outcome is unknown.
    expect(
      await turn("synthetic-sent", () =>
        receivedGatewayResponse(
          Response.json(
            { error: { type: "server_error", message: "Synthetic outage" } },
            { status: 502 },
          ),
        ),
      ),
    ).toEqual({ status: 502, ask: [{ state: "unknown", answers: 0 }] });
    // Cubby's admission refused before any transport sent it.
    expect(
      await turn("synthetic-refused", async () =>
        Response.json(
          {
            error: {
              type: "cubby_admission_refused",
              message: "Synthetic budget",
            },
          },
          { status: 403 },
        ),
      ),
    ).toEqual({ status: 403, ask: [{ state: "queued", answers: 0 }] });
  });

  it("publishes a held response once the busy gate admits it, calling the model once", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
    });
    let transmitted = 0;
    let holder: Promise<void> | undefined;
    const response = await runAgentTurn(
      ctx.db,
      { runId, generation: "synthetic-gate", request: { turn: 1 } },
      async () => {
        transmitted += 1;
        ({ holder } = await holdGate());
        return receivedGatewayResponse(Response.json({ output: "synthetic" }));
      },
      async () => {},
    );
    await holder;
    expect(response.status).toBe(200);
    expect(transmitted).toBe(1);
    expect(await turnState("synthetic-gate")).toEqual([
      { state: "answered", attempts: 0, token: null, answers: 1 },
    ]);
  });

  it("stops retrying a busy gate once its claim moved, publishing nothing", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
    });
    const other = crypto.randomUUID();
    let transmitted = 0;
    let holder: Promise<void> | undefined;
    const turn = runAgentTurn(
      ctx.db,
      { runId, generation: "synthetic-moved", request: { turn: 1 } },
      async () => {
        transmitted += 1;
        ({ holder } = await holdGate());
        // The claim passes to another caller while this response is in hand;
        // the gate admits a retry, so only the failed renewal stops one.
        await repositoryQueries(ctx.db).execute(sql`
          UPDATE "Ask" SET "claimToken" = ${other}::uuid
          WHERE input->${"input"}->>${"generation"} = ${"synthetic-moved"}`);
        return receivedGatewayResponse(Response.json({ output: "synthetic" }));
      },
      async () => {},
    );
    await expect(turn).rejects.toSatisfy(
      (error) => findPgError(error)?.code === "55P03",
    );
    await holder;
    expect(transmitted).toBe(1);
    expect(await turnState("synthetic-moved")).toEqual([
      { state: "sent", attempts: 0, token: other, answers: 0 },
    ]);
  });
});
