import { writeFileSync } from "node:fs";

import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import { setCfEnv } from "~/server/cf-env";
import { getDb } from "~/server/db/helpers";
import { aiEvaluation } from "~/server/db/schema";
import { scheduleConnectionRefresh } from "~/server/domains/run/repo/connection-refresh";
import { executeAiRefreshTarget } from "~/server/domains/run/service/ai-refresh";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import { createInMemoryVectorizeIndex } from "~/server/generic/embedding/service/semantic/vector-store";
import { refreshSearchDocument } from "~/server/generic/search/repo/search-document";
import {
  captureBackgroundQueue,
  drainDerivedRefreshFrontier,
  withJobFixtureExecution,
} from "~/server/testing/background-queue";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

// Failure mode: per-candidate preparation, repeated source reads and per-publication
// fingerprint checks made one evaluation issue hundreds of serial round trips.
// The budget scales with neither candidate count nor publication count.
const CANDIDATES = 6;
// Ratchet: measured 369 before batching; lower it with each fix, never raise it.
const QUERY_BUDGET = 369;

describe("connection evaluation query budget", () => {
  const ctx = withTestDb();
  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    queue = captureBackgroundQueue();
    const values = Array.from(
      { length: getSemanticEmbeddingConfig().dimensions },
      (_, axis) => (axis === 0 ? 1 : 0),
    );
    setCfEnv(
      fromPartial<Env & { CUBBY_TEST_AI_GATEWAY: { fetch: typeof fetch } }>({
        VECTORIZE: createInMemoryVectorizeIndex(),
        BACKGROUND_QUEUE: { sendBatch: async () => {} },
        CUBBY_TEST_AI_GATEWAY: {
          fetch: async () =>
            Response.json({ data: [{ index: 0, embedding: values }] }),
        },
      }),
    );
  });
  afterEach(() => queue.restore());

  it("evaluates a Product with several Expense candidates within a fixed query budget", async () => {
    const name = "Synthetic budget anvil";
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name }),
      ctx.actor,
    );
    for (let index = 0; index < CANDIDATES; index++) {
      const payment = await createRepoEntity(ctx, "expense", {
        name: `${name} ${index}`,
        cost: 10 + index,
        trade: "other",
        costType: "materials",
      });
      await refreshSearchDocument(ctx.db, "expense", payment.entityId);
    }
    await refreshSearchDocument(ctx.db, "product", item.entityId);
    await drainDerivedRefreshFrontier(ctx.db);
    await activateAiRefresh(ctx.db, "synthetic-query-budget", {
      enabled: true,
    });
    const source = { entityKind: "product", entityId: item.id } as const;
    const { runId } = await scheduleConnectionRefresh(ctx.db, source);
    if (!runId) throw new Error("Synthetic budget evaluation missing");
    const [evaluation] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.runId, runId));
    if (!evaluation) throw new Error("Synthetic budget target missing");
    const { queryCount, statements } = await countTestDbQueries(() =>
      withJobFixtureExecution(
        ctx.db,
        {
          key: `ai-evaluation:${evaluation.id}`,
          kind: "ai.evaluation",
          input: { evaluationId: evaluation.id },
        },
        // The in-memory semantic index cannot confirm coverage, so the final
        // commit retains retryable work; preparation and publication still run.
        () =>
          executeAiRefreshTarget(ctx.db, evaluation.id, {
            context: kernelCtx(ctx),
          }).catch((error: unknown) => {
            if (!/coverage is unconfirmed/.test(String(error))) throw error;
          }),
      ),
    );
    if (process.env.CUBBY_QUERY_BUDGET_REPORT)
      writeFileSync(
        process.env.CUBBY_QUERY_BUDGET_REPORT,
        [`${queryCount} queries`, ...statements].join("\n"),
      );
    expect(queryCount).toBeLessThanOrEqual(QUERY_BUDGET);
  });
});
