import { aiEvaluationTarget } from "@cubby/schemas/ai-evaluation";
import type { RunId } from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import { aiEvaluation, aiEvaluationRequest } from "~/server/db/schema";
import { aiEvaluationsForRun } from "~/server/domains/run/repo/ai-work-state";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";

import {
  PENDING_AI_STATES,
  requestedAiEvaluations,
} from "./ai-evaluation-requests";
import {
  readEvaluationErrorText,
  readEvaluationOutcomes,
  readEvaluationTally,
  readFailedEvaluations,
  readFirstEvaluationErrors,
  type EvaluationScope,
} from "./evaluation-tally";

const STATES = [
  "queued",
  "result_ready",
  "completed",
  "blocked",
  "failed",
  "obsolete",
  "cancelled",
] as const;
const JSON_NULL = Symbol("stored JSON null");
const uuid = () => crypto.randomUUID();
const connection = () => ({
  kind: "connection",
  entity: "email",
  recordId: uuid(),
  field: null,
  suggestionIds: [],
});
/** Everything the row filters could see: edge shapes are the point, so none is written by product code. */
const TARGETS: (() => object)[] = [
  connection,
  () => ({ ...connection(), field: "not-null" }),
  () => ({ ...connection(), recordId: "not-a-uuid" }),
  () => ({ ...connection(), entity: 7 }),
  () => ({ ...connection(), suggestionIds: [uuid()] }),
  () => ({
    kind: "connection",
    entity: "email",
    recordId: uuid(),
    suggestionIds: [],
  }),
  () => ({
    kind: "email",
    entity: "email",
    recordId: uuid(),
    field: null,
    suggestionIds: [],
  }),
];
const diagnostic = (reason: string) => ({
  targetId: uuid(),
  stage: "apply",
  reason,
});
type ReceiptSeed = object | string | number | boolean | symbol | null;
const RECEIPTS: (() => ReceiptSeed)[] = [
  () => null,
  () => ({ retryEvaluationId: uuid() }),
  () => ({ retryEvaluationId: "not-a-uuid", outcome: "applied" }),
  () => ({ retryEvaluationId: 7 }),
  () => ({ outcome: "applied" }),
  () => ({ outcome: "queued", diagnostics: [] }),
  () => ({
    outcome: "applied",
    diagnostics: [diagnostic("a"), diagnostic("b")],
  }),
  () => ({ outcome: "queued", diagnostics: [diagnostic("a")] }),
  () => ({
    outcome: "applied",
    diagnostics: [{ ...diagnostic("bad"), stage: "unknown" }],
  }),
  () => ({ outcome: "applied", diagnostics: null }),
  () => ({ outcome: 7 }),
  () => ({ other: true }),
  () => "applied",
  () => JSON_NULL,
  () => false,
  () => 0,
  () => "",
];
const ERRORS = [null, "", "Synthetic failure"];

const isRetried = (receipt: unknown) =>
  z.object({ retryEvaluationId: z.uuid() }).safeParse(receipt).success;
const outcomeReceipt = z.object({
  outcome: z.string(),
  diagnostics: z
    .array(
      z.object({
        targetId: z.string(),
        stage: z.enum(["apply", "paired_model"]),
        reason: z.string(),
      }),
    )
    .optional(),
});

/** The application rules these reads replaced, applied to the same rows. */
function expected(
  items: readonly {
    id: string;
    state: string;
    receipt: unknown;
    error: string | null;
  }[],
) {
  const count = (state: string) =>
    items.filter((item) => item.state === state).length;
  const receipts = items.map((item) => outcomeReceipt.safeParse(item.receipt));
  const outcome = (value: string) =>
    receipts.filter((entry) => entry.success && entry.data.outcome === value)
      .length;
  return {
    tally: {
      total: items.length,
      queued: count("queued"),
      resultReady: count("result_ready"),
      completed: count("completed"),
      blocked: count("blocked"),
      failed: count("failed"),
      obsolete: count("obsolete"),
      cancelled: count("cancelled"),
      pending: items.filter((item) =>
        PENDING_AI_STATES.some((state) => state === item.state),
      ).length,
    },
    outcomes: {
      applied: outcome("applied"),
      queued: outcome("queued"),
      reasons: receipts
        .flatMap((entry) =>
          entry.success ? (entry.data.diagnostics ?? []) : [],
        )
        .map((entry) => entry.reason),
    },
    failed: items
      .filter((item) => item.state === "failed")
      .map((item) => item.id),
    errors: items.flatMap((item) => (item.error ? [item.error] : [])),
  };
}

describe("evaluation tally", () => {
  const ctx = withTestDb();
  const newRun = () => ensureRun(ctx.db, ctx.actor, { purpose: "sweep" });
  /** Stored JSON `null`, which the driver reads back as a missing receipt. */
  const stored = (receipt: unknown) =>
    receipt === JSON_NULL ? sql`'null'::jsonb` : receipt;
  type Seed = {
    target: unknown;
    state: string;
    receipt: unknown;
    error: string | null;
    executionKind?: "ai_refresh" | "suggestion_sweep";
  };
  const insert = async (runId: RunId | null, seeds: readonly Seed[]) => {
    const ids: string[] = [];
    for (let index = 0; index < seeds.length; index += 500) {
      const rows = await getDb(ctx.db)
        .insert(aiEvaluation)
        .values(
          seeds.slice(index, index + 500).map((seed) => ({
            runId,
            executionKind: seed.executionKind ?? "ai_refresh",
            // Malformed targets would otherwise share one open slot.
            feature: `synthetic-${uuid()}`,
            workKey: uuid(),
            // SAFETY: malformed shapes are this test's subject; the column type forbids them.
            target: seed.target as typeof aiEvaluation.$inferInsert.target,
            provenance: {
              dependencies: [],
              inputFingerprint: uuid(),
              optionFingerprint: "synthetic",
              model: null,
            },
            snapshot: {},
            // SAFETY: every member of STATES is a stored state.
            state: seed.state as typeof aiEvaluation.$inferInsert.state,
            receipt: stored(seed.receipt),
            error: seed.error,
          })),
        )
        .returning({ id: aiEvaluation.id });
      ids.push(...rows.map((row) => row.id));
    }
    return ids;
  };
  const combinations = () =>
    STATES.flatMap((state) =>
      TARGETS.flatMap((target) =>
        RECEIPTS.flatMap((receipt) =>
          ERRORS.map((error) => ({
            target: target(),
            state,
            receipt: receipt(),
            error,
          })),
        ),
      ),
    );

  async function assertMatches(
    scope: EvaluationScope,
    items: Parameters<typeof expected>[0],
  ) {
    const want = expected(items);
    const tally = await readEvaluationTally(ctx.db, scope);
    expect(tally).toEqual(want.tally);
    const outcomes = await readEvaluationOutcomes(ctx.db, scope);
    expect(outcomes.tally).toEqual(want.tally);
    expect({
      applied: outcomes.applied,
      queued: outcomes.queued,
      reasons: outcomes.diagnostics.map((entry) => entry.reason).sort(),
    }).toEqual({
      ...want.outcomes,
      reasons: [...want.outcomes.reasons].sort(),
    });
    const failed = await readFailedEvaluations(ctx.db, scope);
    expect(failed.map((row) => row.id).sort()).toEqual([...want.failed].sort());
    expect(
      (await readEvaluationErrorText(ctx.db, scope))?.split("\n").sort() ?? [],
    ).toEqual([...want.errors].sort());
    expect(await readFirstEvaluationErrors(ctx.db, scope, 10)).toHaveLength(
      Math.min(10, want.errors.length),
    );
  }

  it("matches the row rules for a Run's connection evaluations", async () => {
    const runId = await newRun();
    await insert(runId, combinations());
    const items = (await aiEvaluationsForRun(ctx.db, runId))
      .filter(
        (item) =>
          aiEvaluationTarget.safeParse(item.target).data?.kind === "connection",
      )
      .filter((item) => !isRetried(item.receipt));
    expect(items.length).toBeGreaterThan(0);
    await assertMatches(
      { runId, source: "owned", connectionsOnly: true },
      items,
    );
  });

  it("matches the row rules for everything a Run owns", async () => {
    const runId = await newRun();
    await insert(runId, combinations().slice(0, 600));
    const items = (await aiEvaluationsForRun(ctx.db, runId)).filter(
      (item) => !isRetried(item.receipt),
    );
    expect(items.length).toBeGreaterThan(0);
    await assertMatches({ runId, source: "owned" }, items);
  });

  it("applies a request's cancellation and receipt, and its execution kind", async () => {
    const runId = await newRun();
    const seeds = STATES.flatMap((state) =>
      RECEIPTS.flatMap((shared) =>
        [undefined, ...RECEIPTS].flatMap((own) =>
          [null, new Date()].map((cancelledAt) => ({
            own: own?.(),
            cancelledAt,
            target: connection(),
            state,
            receipt: shared(),
            error: "Synthetic failure",
          })),
        ),
      ),
    ).map((seed, index) => ({
      ...seed,
      error: index % 3 ? seed.error : null,
      executionKind:
        index % 2 ? ("ai_refresh" as const) : ("suggestion_sweep" as const),
    }));
    const ids = await insert(null, seeds);
    for (let index = 0; index < ids.length; index += 500)
      await getDb(ctx.db)
        .insert(aiEvaluationRequest)
        .values(
          ids.slice(index, index + 500).map((evaluationId, offset) => ({
            runId,
            evaluationId,
            sequence: index + offset,
            receipt:
              seeds[index + offset]?.own === undefined
                ? null
                : stored(seeds[index + offset]?.own),
            cancelledAt: seeds[index + offset]?.cancelledAt ?? null,
          })),
        );
    const rows = await requestedAiEvaluations(ctx.db, runId);
    const current = rows.filter((item) => !isRetried(item.receipt));
    expect(new Set(current.map((item) => item.state)).has("cancelled")).toBe(
      true,
    );
    await assertMatches({ runId, source: "requested" }, current);
    await assertMatches(
      { runId, source: "requested", executionKind: "suggestion_sweep" },
      current.filter((item) => item.executionKind === "suggestion_sweep"),
    );
  });

  it("keeps every failed ref, in order, and messages only for the stored sample", async () => {
    const runId = await newRun();
    const ids = await insert(
      null,
      Array.from({ length: 25 }, (_, index) => ({
        target: connection(),
        state: "failed",
        receipt: null,
        error: `Synthetic failure ${index}`,
      })),
    );
    await getDb(ctx.db)
      .insert(aiEvaluationRequest)
      .values(
        ids.map((evaluationId, sequence) => ({
          runId,
          evaluationId,
          sequence,
        })),
      );
    const failed = await readFailedEvaluations(ctx.db, {
      runId,
      source: "requested",
    });
    expect(failed.map((row) => row.id)).toEqual(ids);
    expect(failed.slice(0, 5).every((row) => row.error === null)).toBe(true);
    expect(failed.slice(-20).map((row) => row.error)).toEqual(
      Array.from(
        { length: 20 },
        (_, index) => `Synthetic failure ${index + 5}`,
      ),
    );
  });
});
