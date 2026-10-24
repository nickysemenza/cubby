import { aiEvaluationState } from "@cubby/schemas/ai-evaluation";
import { assessmentFamily } from "@cubby/schemas/assessment";
import { sweepRunInput } from "@cubby/schemas/run-fields";
import { recordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import type { SourceTransactionRecordInput } from "@cubby/schemas/source-transaction-record";
import { sweepStartInput } from "@cubby/schemas/sweep";
import { eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { DecisionPort } from "~/server/ai/decision-model";
import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import { getDb } from "~/server/db/helpers";
import { ledgerParty, run, transactionImport } from "~/server/db/schema";
import { runHandlers } from "~/server/domains/run/operations/run.server";
import { recordSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import { buildHoldVoidProposals } from "~/server/domains/transaction-import/repo/statement-suggestions";
import { labelStatementSuggestions } from "~/server/domains/transaction-import/service/statement-suggestion-labels";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { systemPrincipal } from "~/server/http/authenticate";
import {
  drainDerivedRefreshFrontier,
  withJobFixtureExecution,
} from "~/server/testing/background-queue";

import { ensureRun } from "../repo/ensure-run";
import { readRunSteps, recordRunStepPage } from "../repo/run-step";
import { advanceStepRun, retryRunStep } from "./step-run";
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
      identity: { kind: "credit_card", network: "visa" },
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

  const memberRequest = async () => {
    const member = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic Sweep member",
      kind: "member",
    });
    await getDb(ctx.db)
      .update(ledgerParty)
      .set({ userId: ctx.actor.userId })
      .where(eq(ledgerParty.shortcode, member.output.id));
    return {
      principal: systemPrincipal(buildKernelContext(ctx.db, ctx.actor.userId)),
      headers: new Headers(),
      signal: new AbortController().signal,
    };
  };

  // The public TIM-code must select the same retained UUID for both operations;
  // accepting it only in the schema would silently broaden the financial pass.
  it("resolves a retained collection for both the estimate and execution without completing it", async () => {
    const request = await memberRequest();
    const scoped = (await account("Synthetic Card", "Synthetic Card (...4242)"))
      .output;
    const saved = await recordRows([row(), row()], "synthetic-retained-sweep");
    await recordRows([row(), row(), row()], "synthetic-unrelated-sweep");
    const retained = await getDb(ctx.db).query.transactionImport.findFirst({
      where: eq(transactionImport.id, saved.batchId!),
    });
    expect(retained).toBeDefined();
    expect(retained?.completedAt).toBeNull();
    const data = sweepStartInput.parse({
      families: [
        {
          family: "statement_transaction",
          importId: retained!.shortcode,
          accountIds: [scoped.id],
          since: "2026-05-01",
        },
      ],
    });
    const estimated = await runHandlers.operations.sweepEstimate({
      request,
      data,
    });
    expect(estimated).toMatchObject({
      ok: true,
      data: { families: [{ family: "statement_transaction", records: 2 }] },
    });
    const started = await runHandlers.operations.sweep({ request, data });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const stored = await getDb(ctx.db).query.run.findFirst({
      where: eq(run.shortcode, started.data.runId),
    });
    expect(sweepRunInput.parse(stored?.input).families).toEqual([
      {
        family: "statement_transaction",
        scope: {
          importId: saved.batchId,
          accountIds: [
            await resolveOrThrow(ctx.db, "financialAccount", scoped.id),
          ],
          since: "2026-05-01",
        },
      },
    ]);
    expect(await drive(stored!.id)).toBe("finished");
    const steps = await readRunSteps(ctx.db, stored!.id);
    expect(steps[0]).toMatchObject({ done: 2, failed: 0, left: 0 });
    expect(
      await getDb(ctx.db).query.transactionImport.findFirst({
        where: eq(transactionImport.id, saved.batchId!),
      }),
    ).toEqual(retained);
    const { rows } = await getDb(ctx.db).execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM "SourceTransactionRecord"
      WHERE "withdrawnAt" IS NOT NULL
    `);
    expect(rows[0]?.count).toBe(0);
  });

  // A later label filter cannot undo a void Suggestion published by the holds
  // step. Its counted population and page must admit the same whole holds.
  it.each([
    { scope: "collection", included: ["selected", "old", "foreign"] },
    { scope: "date", included: ["selected", "foreign", "unrelated"] },
    { scope: "collection/account", included: ["selected", "old"] },
    { scope: "collection/date", included: ["selected", "foreign"] },
  ] as const)(
    "keeps the full statement Sweep hold population inside $scope scope",
    async ({ scope, included }) => {
      const primary = (
        await account("Synthetic hold card", "Synthetic Card (...4242)")
      ).output;
      const foreign = (
        await account("Synthetic foreign hold card", "Other Card (...9999)")
      ).output;
      const held = [
        row({
          providerTransactionId: "selected",
          providerStatus: "pending",
          providerAmount: -20,
        }),
        row({
          providerTransactionId: "old",
          providerStatus: "pending",
          providerAmount: -21,
          statementDate: "2026-04-01",
        }),
        row({
          providerTransactionId: "foreign",
          providerStatus: "pending",
          providerAmount: -22,
          accountDescriptor: "Other Card (...9999)",
        }),
      ];
      const retained = await recordRows(held, "synthetic-retained-holds");
      await recordRows(
        [
          row({
            providerTransactionId: "unrelated",
            providerStatus: "pending",
            providerAmount: -23,
          }),
        ],
        "synthetic-unrelated-hold",
      );
      // Persist explicit complete-window withdrawal proof before restoring the
      // legacy pending transactions that the Sweep must inspect. Incomplete
      // membership alone supplies no disappearance proof.
      for (const [descriptor, ids] of [
        ["Synthetic Card (...4242)", ["selected", "old", "unrelated"]],
        ["Other Card (...9999)", ["foreign"]],
      ] as const) {
        const withdrawal = await recordSourceTransactionRecords(
          ctx.db,
          recordSourceTransactionRecordsInput.parse({
            import: {
              source: "monarch",
              label: "Synthetic confirmed withdrawal",
              fingerprint: `synthetic-withdrawn-holds-${descriptor}`,
              dateKind: "posted",
              observedAt: "2026-11-01T00:00:00Z",
              rowCountDeclared: 0,
              coverage: {
                account: descriptor,
                from: "2026-04-01",
                to: "2026-05-31",
                visibility: "all",
              },
            },
            rows: [],
            complete: true,
            confirmedWithdrawals: ids,
          }),
          ctx.actor,
        );
        expect(withdrawal.withdrawn).toBe(ids.length);
      }
      const observations = await getDb(
        ctx.db,
      ).query.sourceTransactionRecord.findMany();
      for (const observation of observations) {
        await createRepoEntity(ctx, "financialTransaction", {
          accountId:
            observation.accountDescriptor === "Other Card (...9999)"
              ? foreign.id
              : primary.id,
          kind: "other",
          status: "pending",
          amount: observation.amount,
          transactionDate: observation.statementDate,
          sourceRefs: [
            { source: observation.source, externalId: observation.externalId },
          ],
        });
      }
      expect(await buildHoldVoidProposals(ctx.db)).toHaveLength(4);
      const selectedIds = new Set<string>(included);
      const excludedKeys = observations
        .filter((item) => !selectedIds.has(item.providerTransactionId!))
        .map((item) => item.chargeKey);
      const excludedAssessments = () =>
        getDb(ctx.db).execute(sql`
      SELECT * FROM "AssessmentState" WHERE family = ${assessmentFamily.enum.statement_transaction}
        AND data->>${"chargeKey"} IN (${sql.join(
          excludedKeys.map((key) => sql`${key}`),
          sql`, `,
        )}) ORDER BY id
    `);
      const before = await excludedAssessments();
      const collections = await getDb(
        ctx.db,
      ).query.transactionImport.findMany();
      const runId = await startSweep(ctx.db, ctx.actor, {
        trigger: "manual",
        families: [
          {
            family: "statement_transaction",
            scope: {
              ...(scope !== "date" && { importId: retained.batchId! }),
              ...(scope === "collection/account" && {
                accountIds: [
                  await resolveOrThrow(ctx.db, "financialAccount", primary.id),
                ],
              }),
              ...((scope === "date" || scope === "collection/date") && {
                since: "2026-05-01",
              }),
            },
          },
        ],
      });
      expect(await drive(runId)).toBe("finished");
      expect((await excludedAssessments()).rows).toEqual(before.rows);
      expect(
        (await readRunSteps(ctx.db, runId)).find(
          (step) => step.key === "statement_holds",
        ),
      ).toMatchObject({
        state: "done",
        found: included.length,
        done: included.length,
        failed: 0,
        left: 0,
      });
      const { rows: proposed } = await getDb(ctx.db).execute<{
        id: string;
      }>(sql`
      SELECT data->>${"chargeKey"} AS id FROM "AssessmentState"
      WHERE family = ${assessmentFamily.enum.statement_transaction} AND active
        AND data->>${"recommended"} = ${"void"}
    `);
      expect(proposed.map((item) => item.id).sort()).toEqual(
        observations
          .filter((item) => selectedIds.has(item.providerTransactionId!))
          .map((item) => item.chargeKey)
          .sort(),
      );
      expect(await getDb(ctx.db).query.transactionImport.findMany()).toEqual(
        collections,
      );
      expect(
        await getDb(ctx.db).query.sourceTransactionRecord.findMany(),
      ).toEqual(observations);
    },
  );

  it("refuses invalid, missing and deleted collection references before creating work", async () => {
    const request = await memberRequest();
    const saved = await recordRows([row()], "synthetic-deleted-sweep");
    const [deleted] = await getDb(ctx.db)
      .update(transactionImport)
      .set({ deletedAt: new Date() })
      .where(eq(transactionImport.id, saved.batchId!))
      .returning({ shortcode: transactionImport.shortcode });
    const beforeRuns = await getDb(ctx.db).query.run.findMany();
    const beforeJobs = await getDb(ctx.db).execute(
      sql`SELECT * FROM "Job" ORDER BY id`,
    );
    for (const importId of [
      "invalid",
      "FAC-ABCD",
      "TIM-ZZZZ",
      deleted!.shortcode,
    ]) {
      const data = {
        families: [{ family: "statement_transaction", importId }],
      };
      expect(
        await runHandlers.operations.sweepEstimate({ request, data }),
      ).toMatchObject({ ok: false });
      expect(
        await runHandlers.operations.sweep({ request, data }),
      ).toMatchObject({ ok: false });
    }
    expect(await getDb(ctx.db).query.run.findMany()).toEqual(beforeRuns);
    expect(
      (await getDb(ctx.db).execute(sql`SELECT * FROM "Job" ORDER BY id`)).rows,
    ).toEqual(beforeJobs.rows);
  });

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

  it("retries retained generation failures without revisiting new or healthy charges", async () => {
    await account("Synthetic recovery card", "Synthetic Card (...4242)");
    await recordRows([row(), row(), row()], "synthetic-recovery-original");
    const runId = await startSweep(ctx.db, ctx.actor, {
      trigger: "manual",
      families: [{ family: "statement_transaction", scope: {} }],
    });
    expect(await drive(runId)).toBe("finished");
    const { rows: original } = await getDb(ctx.db).execute<{
      source: string;
      chargeKey: string;
    }>(sql`
      SELECT source, "chargeKey" FROM "SourceTransactionRecord" ORDER BY id LIMIT 1
    `);
    const charge = original[0]!;
    // Simulate a committed publication whose after-commit acknowledgement failed.
    await recordRunStepPage(ctx.db, runId, "statement_generate", {
      state: "failed",
      delta: { done: -1, failed: 1 },
      errors: [
        {
          at: new Date().toISOString(),
          ref: `charge:${charge.source}:${charge.chargeKey}`,
          message: "Synthetic after-commit failure",
        },
      ],
    });
    await recordRows([row()], "synthetic-recovery-later-arrival");
    const reopened = await retryRunStep(ctx.db, runId, "statement_generate");
    expect(reopened).not.toBeNull();
    expect(await drive(runId)).toBe("finished");
    const generation = (await readRunSteps(ctx.db, runId)).find(
      (step) => step.key === "statement_generate",
    );
    expect(generation).toMatchObject({
      state: "done",
      done: 3,
      failed: 0,
      meta: { retryRefs: [], retriedFailures: 1 },
    });
    const { rows: counts } = await getDb(ctx.db).execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM "AssessmentState" WHERE family = ${assessmentFamily.enum.statement_transaction} AND active
    `);
    expect(counts[0]?.count).toBe(3);
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
