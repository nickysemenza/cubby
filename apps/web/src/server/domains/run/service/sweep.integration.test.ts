import { assessmentFamily } from "@cubby/schemas/assessment";
import { recordStatementRowsInput } from "@cubby/schemas/statement-row";
import type { StatementRowInput } from "@cubby/schemas/statement-row";
import { eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { DecisionPort } from "~/server/ai/decision-model";
import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import { recordStatementRows } from "~/server/domains/statement-import/repo/statement-row";
import { labelStatementSuggestions } from "~/server/domains/statement-import/service/statement-suggestion-labels";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import type { WorkflowLauncher } from "~/server/workflows/runs/launcher";

import { ensureRun } from "../repo/ensure-run";
import { readRunSteps } from "../repo/run-step";
import { advanceStepRun } from "./step-run";
import { estimateSweep, startSweep } from "./sweep";

const launcher: WorkflowLauncher = {
  create: async () => {},
  terminate: async () => {},
  status: async () => ({ state: "running", error: null }),
};

let position = 0;
const row = (
  overrides: Partial<StatementRowInput> = {},
): StatementRowInput => ({
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

  const recordRows = (rows: StatementRowInput[], fingerprint: string) =>
    recordStatementRows(
      ctx.db,
      recordStatementRowsInput.parse({
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
      const advance = await advanceStepRun(
        ctx.db,
        { runId, attempt },
        undefined,
        launcher,
      );
      if (advance.kind !== "continue") return advance.kind;
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
    const runId = await startSweep(
      ctx.db,
      ctx.actor,
      { trigger: "manual", families },
      launcher,
    );
    expect(await drive(runId)).toBe("finished");
    const [step] = await readRunSteps(ctx.db, runId);
    expect(step).toMatchObject({
      key: "statement_transaction",
      label: "Statements",
      state: "done",
      found: 4,
      done: 3,
      skipped: 1,
      failed: 0,
      left: 0,
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
    const runId = await startSweep(
      ctx.db,
      ctx.actor,
      {
        trigger: "manual",
        families: [{ family: "statement_transaction", scope: {} }],
      },
      launcher,
    );
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
    const second = await labelStatementSuggestions(ctx.db, {
      port: firstChoice,
      runId: labelRun,
      limit: 1,
      after: first.next,
    });
    expect(second.failed).toEqual([]);
    expect(second).toMatchObject({ labelled: 1, stale: 0, next: null });
  });

  // Failure mode: a connection Sweep re-evaluates sources whose evidence has
  // not changed since they were last scanned.
  it("queues connection sources once and skips them on a repeat Sweep", async () => {
    await activateAiRefresh(ctx.db, "synthetic-sweep-connections", {
      enabled: true,
    });
    await createRepoEntity(ctx, "project", { name: "Synthetic shed repair" });
    await createRepoEntity(ctx, "project", { name: "Synthetic fence repair" });
    const families = [
      {
        family: "recommendation" as const,
        scope: { entityKinds: ["project"] },
      },
    ];
    const first = await startSweep(
      ctx.db,
      ctx.actor,
      { trigger: "manual", families },
      launcher,
    );
    // The roster queues both sources on one child Run, then waits on it.
    expect(await drive(first)).toBe("wait");
    const [queued] = await readRunSteps(ctx.db, first);
    expect(queued).toMatchObject({ state: "waiting", found: 2, skipped: 0 });
    expect(queued?.childRunId).not.toBeNull();
    const second = await startSweep(
      ctx.db,
      ctx.actor,
      { trigger: "manual", families },
      launcher,
    );
    expect(await drive(second)).toBe("finished");
    const [repeat] = await readRunSteps(ctx.db, second);
    expect(repeat).toMatchObject({
      state: "done",
      found: 2,
      skipped: 2,
      left: 0,
    });
  });
});
