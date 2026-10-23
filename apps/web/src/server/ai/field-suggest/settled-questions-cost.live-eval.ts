import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { FIELD_SUGGESTIONS_BATCH_MAX } from "@cubby/schemas/ai";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { DecisionPort } from "~/server/ai/decision-model";
import { NONE_KEY } from "~/server/ai/policy/decision-choice";
import {
  inferFieldAssessments,
  inferFieldAssessmentsBatch,
} from "~/server/domains/run/operations/ai.server";
import {
  kernelCtx,
  productFixture,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { executeEntity } from "~/server/entity-kernel";

import { readSettledQuestions } from "./settled-questions";

/**
 * Non-blocking performance evidence (docs/agents/validation.md#performance-review):
 * a synthetic 50-row Product list's category questions, answered live with
 * the model stubbed versus recalled through one batched settled read. Opt-in
 * like every live eval; it makes no provider call. Run it with
 * `pnpm --dir apps/web exec node tooling/dev-services/test-services.ts --
 * vitest run --project live-eval src/server/ai/field-suggest/settled-questions-cost.live-eval.ts`;
 * CUBBY_SETTLED_MEASURE overrides the ignored artifact path.
 */
const output =
  process.env.CUBBY_SETTLED_MEASURE ??
  "../../artifacts/settled-suggestions/measure.json";
const ROWS = 50;

const declines: DecisionPort = async (input) => {
  const keys = Object.keys(input.questions.selection.criteria);
  return {
    answers: {
      selection: {
        type: "choice",
        choice: NONE_KEY,
        confidence: 0.9,
        probabilities: Object.fromEntries(
          keys.map((key) => [
            key,
            key === NONE_KEY ? 0.9 : 0.1 / Math.max(1, keys.length - 1),
          ]),
        ),
      },
    },
  };
};

async function measured<T>(work: () => Promise<T>) {
  const started = performance.now();
  const { result, queryCount } = await countTestDbQueries(work);
  return {
    result,
    sqlStatements: queryCount,
    wallMs: Math.round(performance.now() - started),
  };
}

describe("settled suggestion read cost", () => {
  const ctx = withTestDb();

  it("compares live asks with one batched settled read", async () => {
    const names = Array.from(
      { length: ROWS },
      (_, index) => `Synthetic measured gadget ${index}`,
    );
    const products = [];
    for (const name of names) products.push(await productFixture(ctx, name));
    const question = (name: string) => ({
      field: "categoryId",
      basisMode: "suggested" as const,
      basis: { name, brandName: null },
    });
    const live = await measured(async () => {
      for (const name of names)
        await inferFieldAssessments(
          kernelCtx(ctx),
          {
            entity: "product",
            basisMode: "suggested",
            targets: ["categoryId"],
            basis: { name, brandName: null },
            runKey: crypto.randomUUID(),
          },
          { decisionPort: declines },
        );
    });
    const read = () =>
      readSettledQuestions(
        ctx.db,
        { entity: "product", questions: names.map(question) },
        { decisionPort: declines },
      );
    const warm = await measured(read);
    await executeEntity(kernelCtx(ctx), {
      action: "update",
      entity: "product",
      id: products[0]!.id,
      data: { notes: "Synthetic unrelated edit" },
    });
    const afterWrite = await measured(read);
    const runKey = crypto.randomUUID();
    const items = names.map((name) => ({
      entity: "product" as const,
      basisMode: "suggested" as const,
      targets: ["categoryId"],
      basis: { name, brandName: null },
      runKey,
    }));
    const singletonRevisit = await measured(async () => {
      for (const item of items)
        await inferFieldAssessments(kernelCtx(ctx), item, {
          decisionPort: declines,
        });
    });
    const batchRevisit = await measured(async () => {
      const results = [];
      for (
        let offset = 0;
        offset < items.length;
        offset += FIELD_SUGGESTIONS_BATCH_MAX
      ) {
        const batch = await inferFieldAssessmentsBatch(
          kernelCtx(ctx),
          {
            items: items.slice(offset, offset + FIELD_SUGGESTIONS_BATCH_MAX),
          },
          { decisionPort: declines },
        );
        results.push(...batch.results);
      }
      return results;
    });
    expect(batchRevisit.result.every((result) => result.ok)).toBe(true);
    const hits = (result: Awaited<ReturnType<typeof read>>) =>
      result.results.filter((item) => item.ok && item.value.outcome !== null)
        .length;
    expect(hits(warm.result)).toBe(ROWS);

    const report = {
      revision: process.env.GIT_COMMIT ?? null,
      environment: "local PostgreSQL test database (pnpm test:postgres)",
      workload: `${ROWS} Product rows x categoryId, real category roster, decision model stubbed to decline`,
      cacheState:
        "fresh test database; live path pays one stubbed model call per row",
      live: {
        dispatches: ROWS,
        modelCallsAvoided: ROWS,
        sqlStatements: live.sqlStatements,
        wallMs: live.wallMs,
      },
      settledWarm: {
        dispatches: 1,
        hits: hits(warm.result),
        sqlStatements: warm.sqlStatements,
        wallMs: warm.wallMs,
      },
      settledAfterOneWrite: {
        dispatches: 1,
        hits: hits(afterWrite.result),
        sqlStatements: afterWrite.sqlStatements,
        wallMs: afterWrite.wallMs,
      },
      singletonRevisit: {
        dispatches: ROWS,
        sqlStatements: singletonRevisit.sqlStatements,
        wallMs: singletonRevisit.wallMs,
      },
      batchRevisit: {
        dispatches: Math.ceil(ROWS / FIELD_SUGGESTIONS_BATCH_MAX),
        sqlStatements: batchRevisit.sqlStatements,
        wallMs: batchRevisit.wallMs,
      },
      limits:
        "Synthetic local timings; revisit variants reuse published answers, stub model responses and one run key. No browser latency, response bytes, production query plan or real model latency measured.",
    };
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  });
});
