import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { receivedGatewayResponse } from "~/server/ai/gateway-egress-client";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";

import { runAgentTurn } from "./agent-turn-ask";

describe("agent model turn", () => {
  const ctx = withTestDb();

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
});
