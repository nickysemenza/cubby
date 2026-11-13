import { askState } from "@cubby/schemas/kernel/machinery";
import { recordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import { suggestionFamily } from "@cubby/schemas/suggestion";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq, sql } from "drizzle-orm";
import { createEntity } from "tooling/factories/create";
import { createRepoEntity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { expect, it, vi } from "vitest";
import { z } from "zod";

import * as cfEnv from "~/server/cf-env";
import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import { readRunPass } from "~/server/domains/run/repo/run-execution";
import { recordSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import { advanceRunPass } from "~/server/workflows/runs/pass.fixtures";

import { readRunSteps } from "../repo/run-step";
import { startSweep } from "./sweep";

const gatewayInput = z.object({
  query: z.object({
    questions: z.record(
      z.string(),
      z.object({ criteria: z.record(z.string(), z.string()) }),
    ),
  }),
});

const ctx = withTestDb();

// Failures: an admission refusal loses work, resumption repeats finished
// decisions, batching splits every question, or a Sweep completes before its
// suggestions commit. Runner unit tests own page limits and forced handoffs;
// statement-suggestions integration tests own publication concurrency.
it("resumes a refused statement Sweep and publishes every batched suggestion", async () => {
  const total = 8;
  const owner = await createRepoEntity(ctx, "ledgerParty", {
    name: "Synthetic workflow member",
    kind: "member",
  });
  await createRepoEntity(ctx, "financialAccount", {
    name: "Synthetic workflow card",
    identity: { kind: "credit_card", network: "visa" },
    ledgerPartyId: owner.output.id,

    sourceAliases: [
      {
        source: "monarch",
        alias: "Synthetic Card (...4242)",
        externalAccountId: null,
      },
    ],
  });
  await createEntity(
    buildKernelContext(ctx.db, ctx.actor.userId),
    "spendingCategory",
    {
      name: "Synthetic workflow spending",
    },
  );
  for (let index = 0; index < total; index++)
    await createRepoEntity(ctx, "vendor", {
      name: `Synthetic Merchant ${index}`,
    });
  await recordSourceTransactionRecords(
    ctx.db,
    recordSourceTransactionRecordsInput.parse({
      import: {
        source: "monarch",
        label: "synthetic-workflow.csv",
        fingerprint: "synthetic-workflow",
        dateKind: "posted",
        rowCountDeclared: total,
        notes: null,
      },
      rows: Array.from({ length: total }, (_, index) => ({
        accountDescriptor: "Synthetic Card (...4242)",
        statementDate: "2026-05-04",
        providerAmount: -(10 + index),
        merchant: `Synthetic Merchant ${index}`,
        rawDescription: `SYNTHETIC PURCHASE ${index}`,
        sourceCategory: null,
        providerStatus: "posted",
        providerNotes: null,
        rowPosition: index + 1,
      })),
    }),
    ctx.actor,
  );

  let now = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  let refused = false;
  const admitted: string[] = [];
  let batched = false;
  const egress = vi.spyOn(cfEnv, "getAiGatewayEgress").mockReturnValue(
    fromPartial<NonNullable<ReturnType<typeof cfEnv.getAiGatewayEgress>>>({
      fetch: async (request: Request) => {
        const { query } = gatewayInput.parse(await request.json());
        if (!refused) {
          refused = true;
          return new Response(null, {
            status: 429,
            headers: { "x-cubby-admission-wait": "true", "retry-after": "1" },
          });
        }
        const questions = Object.entries(query.questions);
        batched ||= questions.length > 1;
        admitted.push(...questions.map(([id]) => id));
        return Response.json({
          result: {
            answers: Object.fromEntries(
              questions.map(([id, question]) => {
                const keys = Object.keys(question.criteria);
                return [
                  id,
                  {
                    type: "choice",
                    choice: keys[0],
                    confidence: 0.5,
                    probabilities: Object.fromEntries(
                      keys.map((key, index) => [
                        key,
                        index === 0 ? 0.5 : 0.5 / (keys.length - 1),
                      ]),
                    ),
                  },
                ];
              }),
            ),
          },
        });
      },
    }),
  );
  let waits = 0;
  const wait = async (ms: number) => {
    waits++;
    now += ms;
    vi.setSystemTime(now);
  };
  try {
    const runId = await startSweep(ctx.db, ctx.actor, {
      trigger: "manual",
      families: [{ family: "statement_transaction", scope: {} }],
    });
    for (let page = 0; page < 100; page++) {
      const execution = await readRunPass(ctx.db, runId);
      if (!execution) throw new Error("Missing Sweep execution");
      if (execution.state === "done") break;
      if (["stuck", "cancelled"].includes(execution.state))
        throw new Error(execution.lastError ?? execution.state);
      if (execution.availableAt.getTime() > now)
        await wait(execution.availableAt.getTime() - now);
      await getDb(ctx.db).execute(
        sql`UPDATE "Pass" SET "availableAt" = now() WHERE name = 'run.execute' AND key = ${runId}`,
      );
      // Advancing the synthetic Date also makes this Run's queued Asks due in PostgreSQL.
      await getDb(ctx.db).execute(sql`
        UPDATE "Ask" a SET "availableAt" = now()
        WHERE a.state = ${askState.enum.queued} AND EXISTS (
          SELECT 1 FROM "AskScope" s WHERE s."askId" = a.id AND s."runId" = ${runId}::uuid
        )`);
      await advanceRunPass(ctx.db);
    }
    const [saved] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, runId));
    const steps = await readRunSteps(ctx.db, runId);
    const rows = await getDb(ctx.db).execute<{
      complete: number;
      pending: number;
    }>(
      sql`
      SELECT count(*) FILTER (WHERE NOT coalesce((data->>'needsLabel')::boolean, false))::int AS complete,
        count(*) FILTER (WHERE coalesce((data->>'needsLabel')::boolean, false))::int AS pending
      FROM "Suggestion" WHERE family = ${suggestionFamily.enum.statement_transaction} AND active
    `,
      "objects",
    );
    expect(steps.flatMap((step) => step.errors)).toEqual([]);
    expect(saved?.status).toBe("completed");
    expect(
      steps.every((step) => step.failed === 0 && step.state === "done"),
    ).toBe(true);
    expect(rows[0]).toEqual({ complete: total, pending: 0 });
    expect(waits).toBeGreaterThan(0);
    expect(batched).toBe(true);
    expect(admitted).toHaveLength(total * 2);
  } finally {
    egress.mockRestore();
    vi.useRealTimers();
  }
}, 30_000);
