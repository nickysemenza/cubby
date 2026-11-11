import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import { aiEvaluation } from "~/server/db/schema";

import {
  aiEvaluationDue,
  aiEvaluationNext,
  aiEvaluationStore,
  releaseAiEvaluationPage,
} from "./ai-evaluation-work";

const owed = (feature: string) => ({
  executionKind: "ai_refresh" as const,
  feature,
  workKey: crypto.randomUUID(),
  target: {
    kind: "field" as const,
    entity: "expense",
    recordId: crypto.randomUUID(),
    field: "spendingCategoryId",
    suggestionIds: [],
  },
  provenance: {
    dependencies: [],
    inputFingerprint: "synthetic",
    optionFingerprint: "synthetic",
    model: null,
  },
  snapshot: {},
  state: "queued" as const,
  runAt: new Date(Date.now() - 1000),
});

// Failure mode: two pages of one feature publish SERIALIZABLE transactions
// side by side, abort each other on shared rows, and the feature stalls in
// retry backoff.
describe("AI evaluation pages", () => {
  const ctx = withTestDb();

  it("admit one live page per feature, leaving other features free", async () => {
    await getDb(ctx.db)
      .insert(aiEvaluation)
      .values([
        owed("synthetic-money-field"),
        owed("synthetic-money-field"),
        owed("synthetic-money-field"),
        owed("synthetic-other-field"),
      ]);
    const page = crypto.randomUUID();
    const first = await aiEvaluationStore("synthetic-money-field", page).claim(
      ctx.db,
      2,
    );
    expect(first).toHaveLength(2);
    const due = async () =>
      z
        .array(z.object({ unit: z.string() }))
        .parse(
          (await getDb(ctx.db).execute<{ unit: string }>(aiEvaluationDue("ai")))
            .rows,
        )
        .map((row) => row.unit);
    expect(await due()).toEqual(["ai:synthetic-other-field"]);
    expect(
      await aiEvaluationStore(
        "synthetic-money-field",
        crypto.randomUUID(),
      ).claim(ctx.db, 8),
    ).toEqual([]);
    expect(
      await aiEvaluationStore(
        "synthetic-other-field",
        crypto.randomUUID(),
      ).claim(ctx.db, 8),
    ).toHaveLength(1);
    // A page that dies keeps its feature until the lease lapses; the next
    // wake is that lapse, not the unleased backlog behind it.
    const [next] = z
      .array(z.object({ min: z.coerce.date() }))
      .parse(
        (await getDb(ctx.db).execute<{ min: string }>(aiEvaluationNext())).rows,
      );
    expect(next!.min.getTime()).toBeGreaterThan(Date.now() + 15 * 60_000);
    await releaseAiEvaluationPage(ctx.db, page);
    expect(
      await aiEvaluationStore(
        "synthetic-money-field",
        crypto.randomUUID(),
      ).claim(ctx.db, 8),
    ).toHaveLength(3);
  });
});
