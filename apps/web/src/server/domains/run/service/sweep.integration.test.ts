import { aiEvaluationState } from "@cubby/schemas/ai-evaluation";
import { assessmentFamily } from "@cubby/schemas/assessment";
import { recordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import type { SourceTransactionRecordInput } from "@cubby/schemas/source-transaction-record";
import { eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { DecisionPort } from "~/server/ai/decision-model";
import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import { recordSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import { labelStatementSuggestions } from "~/server/domains/transaction-import/service/statement-suggestion-labels";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  drainDerivedRefreshFrontier,
  withJobFixtureExecution,
} from "~/server/testing/background-queue";

import { ensureRun } from "../repo/ensure-run";
import { readRunSteps } from "../repo/run-step";
import { advanceStepRun } from "./step-run";
import { estimateSweep, startSweep } from "./sweep";

let position = 0;
const row = (
  overrides: Partial<SourceTransactionRecordInput> = {},
): SourceTransactionRecordInput => ({
  accountDescriptor: "Synthetic Card (...4242)",
  statementDate: "2026-05-04",
  providerAmount: -12.5,
  merchant: "Example Grocer",
  rawDescription: `EXAMPLE GROCER ${++position}`,
  sourceCategory: "Groceries",
  providerStatus: "posted",
  providerNotes: null,
  rowPosition: position,
  ...overrides,
});

const firstChoice: DecisionPort = async (input) => {
  const keys = Object.keys(input.questions.selection.criteria);
  return {
    answers: {
      selection: {
        type: "choice",
        choice: keys[0]!,
        confidence: 0.97,
        probabilities: Object.fromEntries(
          keys.map((key, index) => [
            key,
            index === 0 ? 0.97 : 0.03 / (keys.length - 1),
          ]),
        ),
      },
    },
  };
};

describe("Sweeps", () => {
  const ctx = withTestDb();

  const account = (name: string, alias: string) =>
    createRepoEntity(ctx, "financialAccount", {
      name,
      identity: { kind: "credit_card", issuer: null, network: "visa" },
      sourceAliases: [{ source: "monarch", alias, externalAccountId: null }],
    });

  const recordRows = (
    rows: SourceTransactionRecordInput[],
    fingerprint: string,
  ) =>
    recordSourceTransactionRecords(
      ctx.db,
      recordSourceTransactionRecordsInput.parse({
        import: {
          source: "monarch",
          label: "synthetic-export.csv",
          fingerprint,
          dateKind: "posted",
          rowCountDeclared: null,
          notes: null,
        },
        rows,
      }),
      ctx.actor,
    );

  const drive = async (runId: string) => {
    const [owner] = await getDb(ctx.db)
      .select({ progress: run.progress })
      .from(run)
      .where(eq(run.id, runId as never));
    const attempt = z
      .object({ attempt: z.number() })
      .parse(owner?.progress).attempt;
    for (let page = 0; page < 50; page++) {
      const advance = await withJobFixtureExecution(
        ctx.db,
        {
          key: `run:${runId}`,
          kind: "run.execute",
          input: { runId, purpose: "sweep" },
          runId,
        },
        () => advanceStepRun(ctx.db, { runId, attempt }),
      );
      if (advance.kind !== "continue") return advance.kind;
      // An evaluate step waits on its ai.evaluation Jobs.
      if (advance.waitSeconds) return "wait";
    }
    return "unbounded";
  };

  // Failure modes: a statement pass runs outside a Run (invisible progress),
  // or an account scope generates suggestions for every account.
  it("runs a scoped statement pass as a visible step with its counts", async () => {
    const scoped = (await account("Synthetic Card", "Synthetic Card (...4242)"))
      .output;
    await account("Other Card", "Other Card (...9999)");
    await recordRows([row(), row(), row()], "fp-sweep-scoped");
    await recordRows(
      [row({ accountDescriptor: "Other Card (...9999)" })],
      "fp-sweep-other",
    );
    const families = [
      {
        family: "statement_transaction" as const,
        scope: {
          accountIds: [
            await resolveOrThrow(ctx.db, "financialAccount", scoped.id),
          ],
        },
      },
    ];
    // The estimate bounds by import and date; the account narrows at generation.
    expect(await estimateSweep(ctx.db, families)).toEqual([
      expect.objectContaining({ family: "statement_transaction", records: 4 }),
    ]);
    const runId = await startSweep(ctx.db, ctx.actor, {
      trigger: "manual",
      families,
    });
    expect(await drive(runId)).toBe("finished");
    const steps = await readRunSteps(ctx.db, runId);
    expect(steps.map((step) => step.key)).toEqual([
      "statement_generate",
      "statement_holds",
      "statement_label",
    ]);
    expect(steps[0]).toMatchObject({
      label: "Statements: match",
      state: "done",
      done: 3,
      failed: 0,
      left: 0,
      meta: { input: { mode: "count" } },
    });
    const { rows } = await getDb(ctx.db).execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM "AssessmentState" WHERE family = ${assessmentFamily.enum.statement_transaction} AND active`,
    );
    expect(rows[0]?.count).toBe(3);
  });

  // Failure mode (prod label lag): a page of only stale suggestions ended the
  // label chain, so later suggestions were never labelled.
  it("pages labels past stale suggestions instead of stopping", async () => {
    await account("Synthetic Card", "Synthetic Card (...4242)");
    // Inflows with no provider category take their kind from the sign, so
    // each asks the decision model for a kind label.
    await recordRows(
      [
        row({ providerAmount: 20, sourceCategory: null }),
        row({ providerAmount: 30, sourceCategory: null }),
      ],
      "fp-sweep-labels",
    );
    const runId = await startSweep(ctx.db, ctx.actor, {
      trigger: "manual",
      families: [{ family: "statement_transaction", scope: {} }],
    });
    await drive(runId);
    const { rows: waiting } = await getDb(ctx.db).execute<{ id: string }>(
      sql`SELECT id FROM "AssessmentState" WHERE family = ${assessmentFamily.enum.statement_transaction} AND active AND (data->>'needsLabel')::boolean ORDER BY "createdAt", id`,
    );
    expect(waiting).toHaveLength(2);
    // The oldest suggestion's evidence moved after publication.
    await getDb(ctx.db).execute(
      sql`UPDATE "AssessmentState" SET data = jsonb_set(data, '{evidenceFingerprint}', '"moved"') WHERE id = ${waiting[0]!.id}::uuid`,
    );
    const labelRun = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
    });
    const first = await labelStatementSuggestions(ctx.db, {
      port: firstChoice,
      runId: labelRun,
      limit: 1,
    });
    expect(first).toMatchObject({ labelled: 0, stale: 1 });
    expect(first.next).not.toBeNull();
    // Failure mode: a charge's failure kept only the driver's "Failed query"
    // text, dropping the Postgres cause and its SQLSTATE.
    const broken = await labelStatementSuggestions(ctx.db, {
      port: async () => {
        throw new Error("Failed query: synthetic", {
          cause: Object.assign(
            new Error("canceling statement due to statement timeout"),
            { code: "57014" },
          ),
        });
      },
      runId: labelRun,
      limit: 1,
      after: first.next,
    });
    expect(broken.failed).toHaveLength(1);
    expect(broken.failed[0]?.message).toContain("57014");
    expect(broken.failed[0]?.message).toContain("statement timeout");
    const second = await labelStatementSuggestions(ctx.db, {
      port: firstChoice,
      runId: labelRun,
      limit: 1,
      after: first.next,
    });
    expect(second.failed).toEqual([]);
    expect(second).toMatchObject({ labelled: 1, stale: 0, next: null });
  });

  const evaluationsOf = async (runId: string) => {
    const { rows } = await getDb(ctx.db).execute<{
      state: string;
      job: string | null;
    }>(sql`SELECT e.state, j.state AS job FROM "AiEvaluation" e
      LEFT JOIN "Job" j ON j.key = 'ai-evaluation:' || e.id::text
      WHERE e."runId" = ${runId}::uuid
        OR e.id IN (SELECT "evaluationId" FROM "AiEvaluationRequest" WHERE "runId" = ${runId}::uuid)`);
    return rows;
  };
  const childRuns = async (runId: string) =>
    getDb(ctx.db)
      .select({ id: run.id })
      .from(run)
      .where(eq(run.parentRunId, runId as never));

  // Failure modes: a connection Sweep re-evaluates sources whose evidence has
  // not changed since they were last scanned, or parks its evaluations on a
  // child Run that holds AI refresh capacity (#2873).
  it("queues connection evaluations on the Sweep once and skips them on a repeat Sweep", async () => {
    await activateAiRefresh(ctx.db, "synthetic-sweep-connections", {
      enabled: true,
    });
    await createRepoEntity(ctx, "project", { name: "Synthetic shed repair" });
    await createRepoEntity(ctx, "project", { name: "Synthetic fence repair" });
    await drainDerivedRefreshFrontier(ctx.db);
    const families = [
      {
        family: "recommendation" as const,
        scope: { entityKinds: ["project"] },
      },
    ];
    const first = await startSweep(ctx.db, ctx.actor, {
      trigger: "manual",
      families,
    });
    expect(await drive(first)).toBe("wait");
    const [roster, evaluate] = await readRunSteps(ctx.db, first);
    expect(roster).toMatchObject({ state: "done", found: 2, done: 2 });
    expect(evaluate).toMatchObject({
      state: "running",
      found: 2,
      meta: { action: "Waiting for 2 of 2 evaluations" },
    });
    expect(await childRuns(first)).toEqual([]);
    expect(await evaluationsOf(first)).toEqual([
      { state: "queued", job: "queued" },
      { state: "queued", job: "queued" },
    ]);
    const second = await startSweep(ctx.db, ctx.actor, {
      trigger: "manual",
      families,
    });
    expect(await drive(second)).toBe("finished");
    const [repeat] = await readRunSteps(ctx.db, second);
    expect(repeat).toMatchObject({
      state: "done",
      found: 2,
      skipped: 2,
      left: 0,
      meta: { reasons: { already_evaluated: 2 } },
    });
  });

  // Failure mode (#2722 review): a scheduled Sweep's connection work was
  // created manual, so its evaluations paid instead of waiting for credit.
  it("makes a scheduled Sweep's connection evaluations background work", async () => {
    await activateAiRefresh(ctx.db, "synthetic-sweep-background", {
      enabled: true,
    });
    await createRepoEntity(ctx, "project", { name: "Synthetic gutter repair" });
    await drainDerivedRefreshFrontier(ctx.db);
    const runId = await startSweep(ctx.db, ctx.actor, {
      trigger: "scheduled",
      families: [
        { family: "recommendation", scope: { entityKinds: ["project"] } },
      ],
    });
    expect(await drive(runId)).toBe("wait");
    const { isBackgroundRun } = await import("~/server/ai/funding");
    expect(await isBackgroundRun(ctx.db, runId)).toBe(true);
  });

  const fieldSweep = () =>
    startSweep(ctx.db, ctx.actor, {
      trigger: "manual",
      families: [
        {
          family: "field",
          scope: {
            targets: [{ entity: "project", fields: ["kind"], filters: {} }],
          },
        },
      ],
    });

  // Review finding: the evaluate step counted a completed evaluation as both
  // done and skipped, so a finished step overstated its inputs.
  it("counts each settled field evaluation once", async () => {
    await createRepoEntity(ctx, "project", { name: "Synthetic porch repair" });
    const runId = await fieldSweep();
    expect(await drive(runId)).toBe("wait");
    const requested = await evaluationsOf(runId);
    await getDb(ctx.db).execute(
      sql`UPDATE "AiEvaluation" SET state = ${aiEvaluationState.enum.completed} WHERE id IN (SELECT "evaluationId" FROM "AiEvaluationRequest" WHERE "runId" = ${runId}::uuid)`,
    );
    await getDb(ctx.db).execute(
      sql`UPDATE "RunStep" SET meta = meta - 'capacityUntil' WHERE "runId" = ${runId}::uuid`,
    );
    expect(await drive(runId)).toBe("finished");
    const [, evaluate] = await readRunSteps(ctx.db, runId);
    expect(evaluate).toMatchObject({
      key: "field_evaluate",
      state: "done",
      done: requested.length,
      skipped: 0,
    });
  });

  // Failure modes: a field Sweep step finishes before its evaluations do, or
  // fans out a child Run instead of requesting evaluations itself; cancelling
  // the Sweep leaves its evaluation Jobs running.
  it("requests field evaluations on the Sweep, waits for them, and cancels them with it", async () => {
    await createRepoEntity(ctx, "project", { name: "Synthetic deck repair" });
    const runId = await fieldSweep();
    expect(await drive(runId)).toBe("wait");
    expect(await childRuns(runId)).toEqual([]);
    const [roster, evaluate] = await readRunSteps(ctx.db, runId);
    expect(roster).toMatchObject({
      key: "field_roster",
      state: "done",
      done: 1,
    });
    expect(evaluate).toMatchObject({ key: "field_evaluate", state: "running" });
    const pending = await evaluationsOf(runId);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((item) => item.job === "queued")).toBe(true);

    const shortcode = (
      await getDb(ctx.db)
        .select({ shortcode: run.shortcode })
        .from(run)
        .where(eq(run.id, runId))
    )[0]!.shortcode;
    const { controlWorkflowRun } =
      await import("~/server/workflows/runs/control");
    await controlWorkflowRun(
      ctx.db,
      ctx.actor,
      { runPublicId: shortcode, action: "cancel" },
      "sweep",
    );
    expect(
      (await evaluationsOf(runId)).every(
        (item) => item.state === "cancelled" && item.job === "cancelled",
      ),
    ).toBe(true);
  });
});
