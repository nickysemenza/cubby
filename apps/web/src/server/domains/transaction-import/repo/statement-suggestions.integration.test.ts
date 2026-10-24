import { readFileSync } from "node:fs";

import {
  assessmentSubjects,
  assessmentFamily,
  assessmentProducer,
} from "@cubby/schemas/assessment";
import { financialSpendingAdvice } from "@cubby/schemas/financial-booking";
import type { FinancialTransactionKind } from "@cubby/schemas/financial-transaction";
import {
  recordSourceTransactionRecordsInput,
  type TransactionImportInput,
  type SourceTransactionRecordInput,
} from "@cubby/schemas/source-transaction-record";
import {
  STATEMENT_LABEL_REVISION,
  type StatementSuggestionOut,
  type StatementTransactionApplication,
} from "@cubby/schemas/statement-suggestion";
import { workQueueHouseholdInput } from "@cubby/schemas/work-queue";
import { DECISION_MODEL } from "@cubby/shared/ai/models";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createEntity } from "tooling/factories/create";
import { createRepoIdentity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AiBudgetExhaustedError } from "~/server/ai/budget";
import type { DecisionPort } from "~/server/ai/decision-model";
import * as decisionModel from "~/server/ai/decision-model";
import { coordinatedGatewayRequest } from "~/server/ai/gateway-egress-client";
import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import * as cfEnv from "~/server/cf-env";
import { getDb, notDeleted } from "~/server/db/helpers";
import * as databaseHelpers from "~/server/db/helpers";
import {
  assessmentState,
  assessment,
  feedback,
  run,
  runStep,
  job,
  automaticRule,
  appSettings,
  transactionImport,
  transactionImportRecord,
  purchase,
  expense,
  financialTransaction,
  financialTransactionAllocation,
  spendingCategory,
  sourceTransactionRecord,
} from "~/server/db/schema";
import * as statementPreview from "~/server/domains/financial-transaction/repo/financial-statement-preview";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import {
  ensureRunSteps,
  readRunSteps,
} from "~/server/domains/run/repo/run-step";
import { advanceStepRun } from "~/server/domains/run/service/step-run";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { startSweep } from "~/server/domains/run/service/sweep";
import { answering } from "~/server/domains/transaction-import/repo/statement-decision-port.fixtures";
import * as statementSuggestionsRepo from "~/server/domains/transaction-import/repo/statement-suggestions";
import { labelStatementSuggestions as runStatementLabels } from "~/server/domains/transaction-import/service/statement-suggestion-labels";
import * as statementLabelService from "~/server/domains/transaction-import/service/statement-suggestion-labels";
import * as assessmentRepo from "~/server/generic/assessment/repo/assessment";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { transitionAssessmentStates } from "~/server/generic/assessment/repo/assessment-state";
import * as assessmentStateRepo from "~/server/generic/assessment/repo/assessment-state";
import * as automaticRuleRuntime from "~/server/generic/assessment/repo/automatic-rule-runtime";
import { setAutomaticRule } from "~/server/generic/assessment/repo/automatic-rule-runtime";
import { ruleBase } from "~/server/generic/assessment/repo/automatic-rules";
import {
  acceptCleanSuggestions,
  listSuggestionPage,
} from "~/server/generic/assessment/repo/suggestion-list";
import { currentJobExecution } from "~/server/generic/jobs/context";
import { JobDeferredError } from "~/server/generic/jobs/errors";
import { cancelJob, renewJob } from "~/server/generic/jobs/repo/jobs";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { readWorkQueue } from "~/server/generic/work-queue/service/work-queue-read";
import {
  captureBackgroundQueue,
  withJobFixtureExecution,
} from "~/server/testing/background-queue";

import {
  getSourceTransactionRecordSummary,
  recordSourceTransactionRecords,
  updateSourceTransactionRecords,
} from "./source-transaction-record";
import { listSourceTransactionRecords } from "./source-transaction-record.fixtures";
import {
  buildChargeProposals,
  generateStatementSuggestionPage,
  generateStatementHoldVoidPage,
  labelledProposal,
  publishChargeProposal,
  retryStatementGenerationRefs,
} from "./statement-suggestions";

const importInput = (
  overrides: Partial<TransactionImportInput> = {},
): TransactionImportInput => ({
  source: "monarch",
  label: "synthetic-export.csv",
  fingerprint: "fp-suggest-1",
  dateKind: "posted" as const,
  rowCountDeclared: null,
  notes: null,
  ...overrides,
});

let position = 0;
const rowInput = (
  overrides: Partial<SourceTransactionRecordInput> = {},
): SourceTransactionRecordInput => ({
  accountDescriptor: "Synthetic Card (...4242)",
  statementDate: "2026-05-04",
  providerAmount: -42.5,
  merchant: "Example Grocer",
  rawDescription: "EXAMPLE GROCER 0001",
  sourceCategory: "Groceries",
  providerStatus: "posted" as const,
  providerNotes: null,
  rowPosition: ++position,
  ...overrides,
});

type Ctx = ReturnType<typeof withTestDb>;

const labelStatementSuggestions: typeof runStatementLabels = async (
  db,
  input,
) => {
  return runStatementLabels(db, {
    ...input,
    spendingAdvice: await statementSpendingAdvice(db),
  });
};

async function statementSpendingAdvice(
  db: Parameters<typeof runStatementLabels>[0],
) {
  const category = await getDb(db).query.spendingCategory.findFirst({
    where: eq(spendingCategory.name, "Synthetic statement spending"),
  });
  const advice: NonNullable<
    Parameters<typeof runStatementLabels>[1]
  >["spendingAdvice"] = async ({ judgment }) =>
    financialSpendingAdvice.parse({
      spendingCategoryId: category?.shortcode,
      categoryConfidence: "high",
      vendorName:
        judgment.create?.merchant ??
        judgment.create?.rawDescription ??
        "Synthetic reviewed business",
      vendorConfidence: "high",
      counterparty: "business",
    });
  return advice;
}

const record = (
  ctx: Ctx,
  rows: SourceTransactionRecordInput[],
  importOverrides: Partial<TransactionImportInput> = {},
) =>
  recordSourceTransactionRecords(
    ctx.db,
    recordSourceTransactionRecordsInput.parse({
      import: importInput(importOverrides),
      rows,
    }),
    ctx.actor,
  );

const card = async (ctx: Ctx) => {
  const owner = await createRepoIdentity(ctx, "ledgerParty", {
    name: "Synthetic statement owner",
    kind: "member",
  });
  await createEntity(
    buildKernelContext(ctx.db, ctx.actor.userId),
    "spendingCategory",
    {
      name: "Synthetic statement spending",
    },
  );
  return createRepoIdentity(ctx, "financialAccount", {
    name: "Synthetic Card",
    ledgerPartyId: owner.output.id,
    provisional: false,
    identity: { kind: "credit_card", network: "visa" },
    sourceAliases: [
      {
        source: "monarch",
        alias: "Synthetic Card (...4242)",
        externalAccountId: null,
      },
    ],
  });
};

const generate = async (ctx: Ctx) => {
  let after = null as Parameters<
    typeof generateStatementSuggestionPage
  >[1]["after"];
  let published = 0;
  for (;;) {
    const page = await generateStatementSuggestionPage(ctx.db, {
      after,
      runId: null,
    });
    published += page.published;
    if (!page.next) break;
    after = page.next;
  }
  let holdAfter: string | null = null;
  for (;;) {
    const page = await generateStatementHoldVoidPage(ctx.db, {
      after: holdAfter,
      runId: null,
    });
    published += page.published;
    if (!page.next) return published;
    holdAfter = page.next;
  }
};

/** Pending statement rows of the cross-family list, newest charge first. */
const suggestions = async (ctx: Ctx) =>
  (
    await listSuggestionPage(ctx.db, {
      family: "statement_transaction",
      limit: 200,
    })
  ).items
    .flatMap((row) =>
      row.family === "statement_transaction" ? [row.evidence] : [],
    )
    .sort(
      (a, b) =>
        b.statementDate.localeCompare(a.statementDate) ||
        a.assessmentId.localeCompare(b.assessmentId),
    );

const accept = async (
  ctx: Ctx,
  suggestion: StatementSuggestionOut,
  overrides: Partial<StatementTransactionApplication> = {},
  corrected = false,
) => {
  // Unlabelled manual cases explicitly review category/business identity;
  // clean/bulk cases retain the advice carried by their published suggestion.
  const category = await getDb(ctx.db).query.spendingCategory.findFirst({
    where: eq(spendingCategory.name, "Synthetic statement spending"),
  });
  const needsBooking =
    suggestion.create !== null &&
    ["purchase", "refund", "fee"].includes(suggestion.create.kind) &&
    suggestion.spending?.status !== "ready" &&
    suggestion.spending?.status !== "already_booked";
  if (needsBooking && !category)
    throw new Error("Synthetic spending category is required");
  const booking = needsBooking
    ? {
        spendingCategoryId: category!.shortcode,
        reviewedVendorName:
          suggestion.merchant ??
          suggestion.rawDescription ??
          "Synthetic reviewed business",
        rejectedPurchaseIds: [],
        categoryHistoryReviewed: true,
      }
    : undefined;
  corrected ||= Boolean(booking);
  const application = {
    kind: "statement_transaction" as const,
    action: suggestion.recommended,
    fields: [],
    rejectedCandidateIds: [],
    ...(booking && { booking }),
    ...overrides,
  };
  return reviewAssessment(ctx.db, kernelCtx(ctx), {
    assessmentId: suggestion.assessmentId,
    operationId: crypto.randomUUID(),
    verdict: corrected ? "wrong" : "correct",
    correction: corrected
      ? { present: true, value: application }
      : { present: false },
    intent: "apply",
    expectedFingerprint: suggestion.fingerprint,
    application,
  });
};

const stateOf = async (ctx: Ctx, assessmentId: string) =>
  (
    await getDb(ctx.db).execute<{ status: string; active: boolean }>(
      sql`SELECT status, active FROM "AssessmentState" WHERE id = ${assessmentId}::uuid`,
    )
  ).rows[0];

const label = async (ctx: Ctx, port: DecisionPort) =>
  labelStatementSuggestions(ctx.db, {
    port,
    runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
  });

/** A member switch enables the real automatic attach path. */
async function enableStatementAttach(ctx: Ctx) {
  await setAutomaticRule(ctx.db, ctx.actor, {
    ruleKey: "statement_transaction.attach",
    enabled: true,
  });
}

/** A real PostgreSQL publication refusal leaves the other pooled writers usable. */
async function rejectStatementPublication(
  ctx: Ctx,
  chargeKey: string,
  producerKind?: "model",
) {
  const client = getDb(ctx.db);
  await client.execute(
    sql`CREATE TABLE "SyntheticStatementPublicationFailure" ("chargeKey" text PRIMARY KEY, "producer" jsonb)`,
  );
  await client.execute(
    sql`INSERT INTO "SyntheticStatementPublicationFailure" VALUES (${chargeKey}, ${producerKind ? JSON.stringify({ kind: producerKind }) : null}::jsonb)`,
  );
  await client.execute(sql`
    CREATE FUNCTION synthetic_statement_publication_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM "SyntheticStatementPublicationFailure" f WHERE f."chargeKey" = NEW.subject->>'chargeKey'
        AND (f.producer IS NULL OR NEW.producer @> f.producer)) THEN
        RAISE EXCEPTION 'Synthetic statement publication failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await client.execute(sql`CREATE TRIGGER synthetic_statement_publication_failure BEFORE INSERT ON "Assessment"
    FOR EACH ROW EXECUTE FUNCTION synthetic_statement_publication_failure()`);
  return async () => {
    await client.execute(
      sql`DROP TRIGGER synthetic_statement_publication_failure ON "Assessment"`,
    );
    await client.execute(
      sql`DROP FUNCTION synthetic_statement_publication_failure()`,
    );
    await client.execute(
      sql`DROP TABLE "SyntheticStatementPublicationFailure"`,
    );
  };
}

async function completeLabelPublications(ctx: Ctx) {
  const pending = await statementSuggestionsRepo.suggestionsNeedingLabels(
    ctx.db,
    100,
  );
  const subjects = pending.map((row) =>
    assessmentSubjects.statement_transaction.parse(row.subject),
  );
  const proposals = await buildChargeProposals(
    ctx.db,
    subjects.map(({ source, chargeKey }) => ({ source, chargeKey })),
  );
  return Promise.all(
    pending.map(async (row, index) => {
      const subject = subjects[index]!;
      const proposal = proposals.find(
        (entry) =>
          entry.charge.source === subject.source &&
          entry.charge.chargeKey === subject.chargeKey,
      );
      if (!proposal) throw new Error("Expected synthetic charge proposal");
      const judgment = structuredClone(proposal.judgment);
      if (judgment.create) {
        judgment.create.votes.label = "purchase";
        judgment.create.counterparty.label = "business";
      }
      for (const candidate of judgment.candidates)
        candidate.label = {
          same: "different",
          confidence: "high",
          model: DECISION_MODEL,
        };
      return {
        proposal: await labelledProposal(proposal, judgment),
        evidenceFingerprint: row.evidenceFingerprint,
        checkpoint: {
          revision: STATEMENT_LABEL_REVISION,
          model: DECISION_MODEL,
          models: [DECISION_MODEL],
          judgment,
          kind: true,
          counterparty: true,
          spending: true,
        },
        producer: {
          kind: "model" as const,
          model: DECISION_MODEL,
          revision: STATEMENT_LABEL_REVISION,
          runId: null,
          evaluationId: null,
        },
      };
    }),
  );
}

describe("statement Transaction suggestions", () => {
  const ctx = withTestDb();

  it.each([false, true])(
    "keeps statement label scope through pending application=%s",
    async (applicationPending) => {
      const account = (await card(ctx)).output;
      await createRepoIdentity(ctx, "financialAccount", {
        name: "Synthetic excluded account",
        identity: { kind: "credit_card", network: "visa" },
        sourceAliases: [
          {
            source: "monarch",
            alias: "Excluded Card",
            externalAccountId: null,
          },
        ],
      });
      await record(ctx, [
        rowInput({
          accountDescriptor: "Excluded Card",
          rawDescription: "EXCLUDED ACCOUNT",
          providerAmount: -11,
        }),
        rowInput({
          statementDate: "2026-04-01",
          rawDescription: "EXCLUDED DATE",
          providerAmount: -22,
        }),
        rowInput({
          statementDate: "2026-05-05",
          rawDescription: "INCLUDED CHARGE",
          providerAmount: -33,
        }),
      ]);
      await generate(ctx);
      if (applicationPending)
        await statementSuggestionsRepo.publishCompleteStatementLabels(
          ctx.db,
          await completeLabelPublications(ctx),
        );
      const accountId = await resolveOrThrow(
        ctx.db,
        "financialAccount",
        account.id,
      );
      const scope = { accountIds: [accountId], since: "2026-05-01" };
      const before = await statementSuggestionsRepo.suggestionsNeedingLabels(
        ctx.db,
        10,
      );
      const excluded = before.filter(
        (entry) => entry.judgment.create?.rawDescription !== "INCLUDED CHARGE",
      );
      const seen: string[] = [];
      const answer = answering({ kind: "other", counterparty: "business" });
      const port: DecisionPort = async (request) => {
        seen.push(request.state);
        return answer(request);
      };
      const partial = applicationPending
        ? null
        : await labelStatementSuggestions(ctx.db, {
            scope,
            port,
            decisionLimit: 1,
          });
      const expectedPartial = expect.objectContaining({
        completed: 0,
        failed: [],
        next: expect.objectContaining({ inclusive: true }),
      });
      expect(partial).toEqual(applicationPending ? null : expectedPartial);
      const outcome = await labelStatementSuggestions(ctx.db, {
        scope,
        port,
        after: partial?.next,
      });
      expect(outcome).toMatchObject({
        completed: 1,
        failed: [],
        stale: 0,
        next: null,
      });
      expect(seen.join("\n")).not.toMatch(/EXCLUDED ACCOUNT|EXCLUDED DATE/);
      const remaining = await statementSuggestionsRepo.suggestionsNeedingLabels(
        ctx.db,
        10,
      );
      expect(remaining.map((entry) => entry.id).sort()).toEqual(
        excluded.map((entry) => entry.id).sort(),
      );
      expect(
        await statementSuggestionsRepo.countSuggestionsNeedingLabels(
          ctx.db,
          scope,
        ),
      ).toBe(0);
    },
  );

  it("intersects statement label count and native/retained pages before their limits", async () => {
    const account = (await card(ctx)).output;
    await createRepoIdentity(ctx, "financialAccount", {
      name: "Synthetic cursor exclusion",
      identity: { kind: "credit_card", network: "visa" },
      sourceAliases: [
        { source: "monarch", alias: "Excluded Card", externalAccountId: null },
      ],
    });
    const input = (index: number) =>
      rowInput({
        providerTransactionId: `synthetic-scope-${index}`,
        rawDescription: `SYNTHETIC SCOPE ${index}`,
        providerAmount: -10 - index,
        ...(index % 3 === 0 &&
          index < 6 && { accountDescriptor: "Excluded Card" }),
        ...(index % 3 === 1 && index < 6 && { statementDate: "2026-04-01" }),
      });
    const first = await record(ctx, [0, 1, 2, 3, 4, 5].map(input));
    await record(ctx, [6, 7].map(input), {
      fingerprint: "synthetic-scope-other-import",
    });
    await generate(ctx);
    const publications = (await completeLabelPublications(ctx)).filter(
      (entry) =>
        [3, 4, 5, 7].some(
          (index) =>
            entry.proposal.canonical.rawDescription ===
            `SYNTHETIC SCOPE ${index}`,
        ),
    );
    await statementSuggestionsRepo.publishCompleteStatementLabels(
      ctx.db,
      publications,
    );
    const rows = await statementSuggestionsRepo.suggestionsNeedingLabels(
      ctx.db,
      20,
    );
    const ordered = [0, 3, 1, 4, 2, 5, 6, 7];
    const ids = new Map<number, string>();
    for (const [order, index] of ordered.entries()) {
      const entry = rows.find(
        (row) =>
          row.judgment.create?.rawDescription === `SYNTHETIC SCOPE ${index}`,
      );
      if (!entry) throw new Error("Synthetic scope cursor missing");
      ids.set(index, entry.id);
      const createdAt = `2026-01-01T00:00:0${order}.000001`;
      // Retained positions are historical state that ordinary writers preserve.
      await getDb(ctx.db)
        .update(assessmentState)
        .set({
          createdAt: new Date(`2026-01-01T00:00:0${order}Z`),
          ...(entry.applicationPending && {
            data: sql`${assessmentState.data} || ${JSON.stringify({ applicationOrder: { createdAt, id: entry.cursorId } })}::jsonb`,
          }),
        })
        .where(eq(assessmentState.id, entry.id));
    }
    const scope = {
      accountIds: [
        await resolveOrThrow(ctx.db, "financialAccount", account.id),
      ],
      since: "2026-05-01",
    };
    for (const [selected, expected] of [
      [scope, [2, 5, 6, 7]],
      [{ ...scope, importId: first.batchId }, [2, 5]],
    ] as const) {
      expect(
        await statementSuggestionsRepo.countSuggestionsNeedingLabels(
          ctx.db,
          selected,
        ),
      ).toBe(expected.length);
      const actual: string[] = [];
      let after: Parameters<
        typeof statementSuggestionsRepo.suggestionsNeedingLabels
      >[2] = null;
      for (;;) {
        const page = await statementSuggestionsRepo.suggestionsNeedingLabels(
          ctx.db,
          1,
          after,
          selected,
        );
        const entry = page[0];
        if (!entry) break;
        actual.push(entry.id);
        after = { createdAt: entry.createdAt, id: entry.cursorId };
        expect(
          (
            await statementSuggestionsRepo.suggestionsNeedingLabels(
              ctx.db,
              1,
              { ...after, inclusive: true },
              selected,
            )
          )[0]?.id,
        ).toBe(entry.id);
      }
      expect(actual).toEqual(expected.map((index) => ids.get(index)));
    }
    const prefix = await statementSuggestionsRepo.suggestionsNeedingLabels(
      ctx.db,
      2,
      null,
      scope,
    );
    const boundary = prefix.at(-1);
    if (!boundary)
      throw new Error("Synthetic scoped preparation boundary missing");
    const preview = vi.spyOn(
      statementPreview,
      "previewFinancialTransactionImport",
    );
    try {
      await statementSuggestionsRepo.suggestionsNeedingLabels(
        ctx.db,
        1,
        { createdAt: boundary.createdAt, id: boundary.cursorId },
        scope,
      );
      expect(
        preview.mock.calls.flatMap(([, input]) =>
          input.rows.map((row) => row.originalStatement),
        ),
      ).toEqual(["SYNTHETIC SCOPE 6"]);
    } finally {
      preview.mockRestore();
    }
  });

  it.each(["ordinary", "shortcut", "resumed ordinary", "resumed shortcut"])(
    "fences %s receipt completion under its original scope",
    async (mode) => {
      const account = (await card(ctx)).output;
      const other = (
        await createRepoIdentity(ctx, "financialAccount", {
          name: "Synthetic receipt completion account",
          identity: { kind: "credit_card", network: "visa" },
        })
      ).output;
      const imported = await record(ctx, [
        rowInput({
          providerTransactionId: "synthetic-receipt-completion-scope",
        }),
      ]);
      await generate(ctx);
      if (mode.startsWith("resumed")) {
        const publications = await Promise.all(
          (await completeLabelPublications(ctx)).map(async (entry) => {
            const judgment = structuredClone(entry.proposal.judgment);
            if (judgment.create) judgment.create.counterparty.label = "person";
            const proposal = await labelledProposal(entry.proposal, judgment);
            return {
              ...entry,
              proposal,
              checkpoint: { ...entry.checkpoint, judgment: proposal.judgment },
            };
          }),
        );
        await statementSuggestionsRepo.publishCompleteStatementLabels(
          ctx.db,
          publications,
        );
      }
      const [source] = (await listSourceTransactionRecords(ctx.db, {})).data;
      if (!source)
        throw new Error("Synthetic receipt completion source missing");
      let before: typeof assessmentState.$inferSelect | undefined;
      const move = async (assessmentId: string) => {
        if (before) return;
        [before] = await getDb(ctx.db)
          .select()
          .from(assessmentState)
          .where(eq(assessmentState.id, assessmentId));
        await updateSourceTransactionRecords(
          ctx.db,
          {
            selector: {
              source: source.source,
              externalIds: [source.externalId],
            },
            data: { accountId: other.id },
          },
          ctx.actor,
        );
      };
      const shortcut = mode.endsWith("shortcut");
      const prefix = statementSuggestionsRepo.completeNoActionStatementPrefix;
      const complete = statementSuggestionsRepo.completeStatementApplications;
      const prefixSpy = vi
        .spyOn(statementSuggestionsRepo, "completeNoActionStatementPrefix")
        .mockImplementation(async (...args) => {
          const [entry] = args[1];
          if (shortcut && entry) await move(entry.assessmentId);
          return prefix(...args);
        });
      const completeSpy = vi
        .spyOn(statementSuggestionsRepo, "completeStatementApplications")
        .mockImplementation(async (...args) => {
          const [id] = args[1];
          if (!shortcut && id) await move(id);
          return complete(...args);
        });
      try {
        const scope = {
          accountIds: [
            await resolveOrThrow(ctx.db, "financialAccount", account.id),
          ],
          since: "2026-05-01",
          // Import admission selects the ordinary zero-applicable-rule path.
          ...(!shortcut && { importId: imported.batchId }),
        };
        const outcome = await labelStatementSuggestions(ctx.db, {
          scope,
          port: answering({ kind: "purchase", counterparty: "person" }),
        });
        if (!before)
          throw new Error(
            "Synthetic receipt completion boundary was not reached",
          );
        expect(outcome).toMatchObject({
          completed: 0,
          stale: 1,
          failed: [],
          next: null,
        });
        expect(z.record(z.string(), z.json()).parse(before.data)).toMatchObject(
          { applicationPending: true, applicationOrder: expect.any(Object) },
        );
        const [after] = await getDb(ctx.db)
          .select()
          .from(assessmentState)
          .where(eq(assessmentState.id, before.id));
        expect(after?.data).toEqual(before.data);
        expect(after?.createdAt).toEqual(before.createdAt);
        expect(
          await statementSuggestionsRepo.suggestionsNeedingLabels(ctx.db, 1),
        ).toMatchObject([{ id: before.id, applicationPending: true }]);
        expect(await getDb(ctx.db).select().from(financialTransaction)).toEqual(
          [],
        );
        expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
      } finally {
        prefixSpy.mockRestore();
        completeSpy.mockRestore();
      }
    },
  );

  it("keeps scoped label scan batches full behind a nearly full output page", async () => {
    const account = (await card(ctx)).output;
    await createRepoIdentity(ctx, "financialAccount", {
      name: "Synthetic scan exclusion",
      identity: { kind: "credit_card", network: "visa" },
      sourceAliases: [
        {
          source: "monarch",
          alias: "Excluded scan card",
          externalAccountId: null,
        },
      ],
    });
    await record(
      ctx,
      Array.from({ length: 69 }, (_, index) =>
        rowInput({
          providerTransactionId: `synthetic-full-scan-${index}`,
          rawDescription: `SYNTHETIC FULL SCAN ${index}`,
          providerAmount: -100 - index,
          ...(index >= 32 &&
            index < 67 && { accountDescriptor: "Excluded scan card" }),
        }),
      ),
    );
    await generate(ctx);
    // The supported publications exist; only their historical cursor positions
    // are arranged to put a long excluded suffix behind 32 admitted rows.
    await getDb(ctx.db).execute(sql`UPDATE "AssessmentState" SET "createdAt" =
      '2026-01-01'::timestamp + ((data->>'amount')::int - 100) * interval '1 second'
      WHERE family = ${assessmentFamily.enum.statement_transaction}`);
    const scope = {
      accountIds: [
        await resolveOrThrow(ctx.db, "financialAccount", account.id),
      ],
    };
    const preview = vi.spyOn(
      statementPreview,
      "previewFinancialTransactionImport",
    );
    try {
      const page = await statementSuggestionsRepo.suggestionsNeedingLabels(
        ctx.db,
        33,
        null,
        scope,
      );
      const batches = preview.mock.calls.map(([, input]) => input.rows.length);
      expect(batches.length).toBeLessThanOrEqual(3);
      expect(batches).not.toContain(1);
      expect(page.map((row) => row.judgment.create?.rawDescription)).toEqual([
        ...Array.from(
          { length: 32 },
          (_, index) => `SYNTHETIC FULL SCAN ${index}`,
        ),
        "SYNTHETIC FULL SCAN 67",
      ]);
      const last = page.at(-1);
      if (!last) throw new Error("Synthetic full scan cursor missing");
      expect(
        (
          await statementSuggestionsRepo.suggestionsNeedingLabels(
            ctx.db,
            1,
            { createdAt: last.createdAt, id: last.cursorId },
            scope,
          )
        ).map((row) => row.judgment.create?.rawDescription),
      ).toEqual(["SYNTHETIC FULL SCAN 68"]);
      expect(
        (
          await statementSuggestionsRepo.suggestionsNeedingLabels(
            ctx.db,
            1,
            { createdAt: last.createdAt, id: last.cursorId, inclusive: true },
            scope,
          )
        )[0]?.id,
      ).toBe(last.id);
    } finally {
      preview.mockRestore();
    }
  });

  it.each(["checkpoint", "publication", "publication fallback"])(
    "fences statement scope inside %s write admission",
    async (phase) => {
      const account = (await card(ctx)).output;
      const other = (
        await createRepoIdentity(ctx, "financialAccount", {
          name: "Synthetic label write race account",
          identity: { kind: "credit_card", network: "visa" },
        })
      ).output;
      const imported = await record(ctx, [
        rowInput({ providerTransactionId: "synthetic-label-write-race" }),
      ]);
      await generate(ctx);
      const [source] = (await listSourceTransactionRecords(ctx.db, {})).data;
      const [before] = await statementSuggestionsRepo.suggestionsNeedingLabels(
        ctx.db,
        1,
      );
      if (!source || !before)
        throw new Error("Synthetic label write race missing");
      let moved = false;
      const move = async () => {
        if (moved) return;
        moved = true;
        await updateSourceTransactionRecords(
          ctx.db,
          {
            selector: {
              source: source.source,
              externalIds: [source.externalId],
            },
            data: { accountId: other.id },
          },
          ctx.actor,
        );
      };
      const checkpoint =
        statementSuggestionsRepo.recordStatementLabelCheckpoint;
      const publish = statementSuggestionsRepo.publishCompleteStatementLabels;
      const publishAssessments = assessmentRepo.publishAssessments;
      const checkpointSpy = vi
        .spyOn(statementSuggestionsRepo, "recordStatementLabelCheckpoint")
        .mockImplementation(async (...args) => {
          if (phase === "checkpoint") await move();
          return checkpoint(...args);
        });
      const publicationSpy = vi
        .spyOn(statementSuggestionsRepo, "publishCompleteStatementLabels")
        .mockImplementation(async (...args) => {
          if (phase === "publication") await move();
          return publish(...args);
        });
      const batchSpy = vi
        .spyOn(assessmentRepo, "publishAssessments")
        .mockImplementation(async (...args) => {
          if (phase === "publication fallback" && !moved) {
            await move();
            throw new Error("Synthetic batch failure before scoped fallback");
          }
          return publishAssessments(...args);
        });
      try {
        const result = await labelStatementSuggestions(ctx.db, {
          scope: {
            importId: imported.batchId,
            accountIds: [
              await resolveOrThrow(ctx.db, "financialAccount", account.id),
            ],
            since: "2026-05-01",
          },
          port: answering({ kind: "other", counterparty: "business" }),
          ...(phase === "checkpoint" && { decisionLimit: 1 }),
        });
        expect(moved).toBe(true);
        expect(result).toMatchObject({ labelled: 0, completed: 0, failed: [] });
        const [retained] = await getDb(ctx.db)
          .select()
          .from(assessmentState)
          .where(eq(assessmentState.id, before.id));
        expect(
          z.record(z.string(), z.json()).parse(retained?.data)
            .labelCheckpoint ?? null,
        ).toBeNull();
        expect(
          await getDb(ctx.db)
            .select({ id: assessment.id })
            .from(assessment)
            .where(
              sql`${assessment.producer}->>${"kind"} = ${assessmentProducer.shape.kind.enum.model}`,
            ),
        ).toEqual([]);
      } finally {
        checkpointSpy.mockRestore();
        publicationSpy.mockRestore();
        batchSpy.mockRestore();
      }
    },
  );

  it("fences recovered statement labels under their original scope", async () => {
    const account = (await card(ctx)).output;
    const other = (
      await createRepoIdentity(ctx, "financialAccount", {
        name: "Synthetic recovery scope account",
        identity: { kind: "credit_card", network: "visa" },
      })
    ).output;
    const imported = await record(ctx, [
      rowInput({ providerTransactionId: "synthetic-recovery-scope" }),
    ]);
    await generate(ctx);
    const entries = await completeLabelPublications(ctx);
    const [entry] = entries;
    const [source] = (await listSourceTransactionRecords(ctx.db, {})).data;
    if (!entry || !source)
      throw new Error("Synthetic recovered scope fixture missing");
    const published =
      await statementSuggestionsRepo.publishCompleteStatementLabels(
        ctx.db,
        entries,
      );
    const receipt = published.get(
      statementSuggestionsRepo.chargeId(entry.proposal.charge),
    );
    if (receipt?.kind !== "ready")
      throw new Error("Synthetic publication receipt missing");
    const before = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.id, receipt.receipt.assessmentId));
    await updateSourceTransactionRecords(
      ctx.db,
      {
        selector: { source: source.source, externalIds: [source.externalId] },
        data: { accountId: other.id },
      },
      ctx.actor,
    );
    const recovered =
      await statementSuggestionsRepo.publishCompleteStatementLabels(
        ctx.db,
        entries,
        {
          importId: imported.batchId,
          accountIds: [
            await resolveOrThrow(ctx.db, "financialAccount", account.id),
          ],
          since: "2026-05-01",
        },
      );
    expect(
      recovered.get(statementSuggestionsRepo.chargeId(entry.proposal.charge)),
    ).toEqual({ kind: "resolved", reason: "out_of_scope" });
    expect(
      await getDb(ctx.db)
        .select()
        .from(assessmentState)
        .where(eq(assessmentState.id, receipt.receipt.assessmentId)),
    ).toEqual(before);
  });

  it.each(["regeneration", "application"])(
    "fences statement scope when accounts change before %s",
    async (phase) => {
      const account = (await card(ctx)).output;
      const owner = (
        await createRepoIdentity(ctx, "ledgerParty", {
          name: "Synthetic second purchaser",
          kind: "member",
        })
      ).output;
      const other = (
        await createRepoIdentity(ctx, "financialAccount", {
          name: "Synthetic race account",
          ledgerPartyId: owner.id,
          provisional: false,
          identity: { kind: "credit_card", network: "visa" },
        })
      ).output;
      const imported = await record(ctx, [
        rowInput({ providerTransactionId: "synthetic-application-scope-race" }),
      ]);
      await generate(ctx);
      const [source] = (await listSourceTransactionRecords(ctx.db, {})).data;
      if (!source)
        throw new Error("Synthetic application scope source missing");
      const regenerate = statementSuggestionsRepo.regenerateCharges;
      const apply = automaticRuleRuntime.applyAutomaticRulesForCharge;
      let moved = false;
      const move = async () => {
        if (moved) return;
        moved = true;
        await updateSourceTransactionRecords(
          ctx.db,
          {
            selector: {
              source: source.source,
              externalIds: [source.externalId],
            },
            data: { accountId: other.id },
          },
          ctx.actor,
        );
      };
      const regeneration = vi
        .spyOn(statementSuggestionsRepo, "regenerateCharges")
        .mockImplementation(async (...args) => {
          if (phase === "regeneration") await move();
          return regenerate(...args);
        });
      const application = vi
        .spyOn(automaticRuleRuntime, "applyAutomaticRulesForCharge")
        .mockImplementation(async (...args) => {
          if (phase === "application" && !moved) {
            await move();
            // A concurrent unscoped refresh may publish reusable labels for B.
            await regenerate(args[0], [args[1]]);
          }
          return apply(...args);
        });
      try {
        await labelStatementSuggestions(ctx.db, {
          scope: {
            importId: imported.batchId,
            accountIds: [
              await resolveOrThrow(ctx.db, "financialAccount", account.id),
            ],
            since: "2026-05-01",
          },
          port: answering({ kind: "purchase", counterparty: "business" }),
        });
        expect(moved).toBe(true);
        expect(await getDb(ctx.db).select().from(financialTransaction)).toEqual(
          [],
        );
        expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
      } finally {
        regeneration.mockRestore();
        application.mockRestore();
      }
    },
  );

  it("rechecks live statement label account scope after model work", async () => {
    const account = (await card(ctx)).output;
    const other = (
      await createRepoIdentity(ctx, "financialAccount", {
        name: "Synthetic reassigned account",
        identity: { kind: "credit_card", network: "visa" },
      })
    ).output;
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const [before] = await statementSuggestionsRepo.suggestionsNeedingLabels(
      ctx.db,
      1,
    );
    const [source] = (await listSourceTransactionRecords(ctx.db, {})).data;
    if (!before || !source)
      throw new Error("Synthetic scope reassignment missing");
    const scope = {
      accountIds: [
        await resolveOrThrow(ctx.db, "financialAccount", account.id),
      ],
    };
    const answer = answering({ kind: "other", counterparty: "business" });
    let reassigned = false;
    const outcome = await labelStatementSuggestions(ctx.db, {
      scope,
      port: async (request) => {
        if (!reassigned) {
          reassigned = true;
          await updateSourceTransactionRecords(
            ctx.db,
            {
              selector: {
                source: source.source,
                externalIds: [source.externalId],
              },
              data: { accountId: other.id },
            },
            ctx.actor,
          );
        }
        return answer(request);
      },
    });
    expect(outcome).toMatchObject({
      labelled: 0,
      completed: 0,
      stale: 1,
      failed: [],
      skippedIds: [before.id],
    });
    expect(
      await statementSuggestionsRepo.countSuggestionsNeedingLabels(
        ctx.db,
        scope,
      ),
    ).toBe(0);
    expect(
      await statementSuggestionsRepo.countSuggestionsNeedingLabels(ctx.db, {
        accountIds: [
          await resolveOrThrow(ctx.db, "financialAccount", other.id),
        ],
      }),
    ).toBe(1);
    expect(
      await statementSuggestionsRepo.suggestionsNeedingLabels(ctx.db, 1),
    ).toMatchObject([
      { id: before.id, checkpoint: null, applicationPending: false },
    ]);
  });

  it("scopes statement label dates on retained observations in the selected import", async () => {
    const account = (await card(ctx)).output;
    const observation = rowInput({
      providerTransactionId: "synthetic-retained-date",
      statementDate: "2026-05-04",
    });
    const first = await record(ctx, [observation], {
      observedAt: "2026-06-01T00:00:00Z",
    });
    const later = await record(
      ctx,
      [{ ...observation, statementDate: "2026-04-01" }],
      {
        fingerprint: "synthetic-corrected-date",
        observedAt: "2026-06-02T00:00:00Z",
      },
    );
    await generate(ctx);
    const scope = {
      accountIds: [
        await resolveOrThrow(ctx.db, "financialAccount", account.id),
      ],
      since: "2026-05-01",
    };
    const page = await statementSuggestionsRepo.suggestionsNeedingLabels(
      ctx.db,
      1,
      null,
      scope,
    );
    expect(page).toMatchObject([{ judgment: { statementDate: "2026-04-01" } }]);
    expect(
      await statementSuggestionsRepo.countSuggestionsNeedingLabels(
        ctx.db,
        scope,
      ),
    ).toBe(1);
    expect(
      await statementSuggestionsRepo.countSuggestionsNeedingLabels(ctx.db, {
        ...scope,
        importId: first.batchId,
      }),
    ).toBe(1);
    expect(
      await statementSuggestionsRepo.countSuggestionsNeedingLabels(ctx.db, {
        ...scope,
        importId: later.batchId,
      }),
    ).toBe(0);
    expect(
      await statementSuggestionsRepo.suggestionsNeedingLabels(ctx.db, 1, null, {
        ...scope,
        importId: later.batchId,
      }),
    ).toEqual([]);
  });

  it("carries the public statement Sweep scope into label count and execution", async () => {
    const account = (await card(ctx)).output;
    await createRepoIdentity(ctx, "financialAccount", {
      name: "Synthetic public sweep exclusion",
      identity: { kind: "credit_card", network: "visa" },
      sourceAliases: [
        { source: "monarch", alias: "Excluded Card", externalAccountId: null },
      ],
    });
    await record(ctx, [
      rowInput({ accountDescriptor: "Excluded Card", providerAmount: -11 }),
      rowInput({ statementDate: "2026-04-01", providerAmount: -22 }),
      rowInput({ statementDate: "2026-05-05", providerAmount: -33 }),
    ]);
    await generate(ctx);
    const actual = statementLabelService.labelStatementSuggestions;
    const advice = await statementSpendingAdvice(ctx.db);
    // Keep the real Sweep/service; inject only its external decision/advice ports.
    const labels = vi
      .spyOn(statementLabelService, "labelStatementSuggestions")
      .mockImplementation((db, input) =>
        actual(db, {
          ...input,
          port: answering({ kind: "other", counterparty: "business" }),
          spendingAdvice: advice,
        }),
      );
    try {
      const runId = await startSweep(ctx.db, ctx.actor, {
        trigger: "manual",
        families: [
          {
            family: "statement_transaction",
            scope: {
              accountIds: [
                await resolveOrThrow(ctx.db, "financialAccount", account.id),
              ],
              since: "2026-05-01",
            },
          },
        ],
      });
      let finished = false;
      for (let page = 0; page < 20; page++) {
        const result = await withJobFixtureExecution(
          ctx.db,
          {
            key: `run:${runId}`,
            kind: "run.execute",
            input: { runId, purpose: "sweep" },
            runId,
          },
          () => advanceStepRun(ctx.db, { runId, attempt: 1 }),
        );
        if (result.kind === "finished") {
          finished = true;
          break;
        }
        expect(result.kind).toBe("continue");
      }
      expect(finished).toBe(true);
      expect(
        (await readRunSteps(ctx.db, runId)).find(
          (step) => step.key === "statement_label",
        ),
      ).toMatchObject({ state: "done", found: 1, done: 1, failed: 0 });
      expect(
        await statementSuggestionsRepo.countSuggestionsNeedingLabels(ctx.db),
      ).toBe(2);
    } finally {
      labels.mockRestore();
    }
  });

  // Failure mode: pages build many charges at once while accept rebuilds one,
  // so any batch-dependent evidence (unordered holds, another account's rows)
  // makes every bulk-built suggestion fail as stale.
  it("builds a page of charges exactly as it builds each one alone", async () => {
    const account = (await card(ctx)).output;
    const vendor = await createRepoIdentity(ctx, "vendor", {
      name: "Example Grocer",
    });
    const receipt = await createRepoIdentity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-05-04",
    });
    await createRepoIdentity(ctx, "expense", {
      purchaseId: receipt.output.id,
      name: "Synthetic nearby receipt",
      cost: 42.5,
      trade: "other",
    });
    await createRepoIdentity(ctx, "financialAccount", {
      name: "Synthetic Debit",
      identity: {
        kind: "bank_account",

        accountType: "checking",
      },
      sourceAliases: [
        {
          source: "monarch",
          alias: "Synthetic Debit (...1111)",
          externalAccountId: null,
        },
      ],
    });
    await createRepoIdentity(ctx, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-05",
      merchant: "Example Grocer",
      rawDescription: "EXAMPLE GROCER 0001",
      sourceRefs: [],
    });
    for (const day of ["2026-04-28", "2026-04-29", "2026-04-30"])
      await createRepoIdentity(ctx, "financialTransaction", {
        accountId: account.id,
        kind: "purchase",
        status: "pending",
        amount: 15,
        transactionDate: day,
        merchant: "Example Bistro",
        rawDescription: "EXAMPLE BISTRO PENDING",
        sourceRefs: [],
      });
    await record(ctx, [
      rowInput(),
      rowInput({
        providerAmount: -15,
        statementDate: "2026-05-01",
        merchant: "Example Bistro",
        rawDescription: "EXAMPLE BISTRO",
        sourceCategory: "Restaurants & Bars",
      }),
      rowInput({
        providerAmount: -15,
        statementDate: "2026-05-02",
        merchant: "Example Bistro",
        rawDescription: "EXAMPLE BISTRO",
        sourceCategory: "Restaurants & Bars",
      }),
      rowInput({
        accountDescriptor: "Synthetic Debit (...1111)",
        providerAmount: -6.25,
        merchant: "Example Cafe",
        rawDescription: "EXAMPLE CAFE",
        sourceCategory: "Coffee Shops",
      }),
    ]);
    const { rows } = await getDb(ctx.db).execute<{
      source: string;
      chargeKey: string;
    }>(
      sql`SELECT source, "chargeKey" FROM "SourceTransactionRecord" WHERE "deletedAt" IS NULL`,
    );
    const charges = rows.map(({ source, chargeKey }) => ({
      source,
      chargeKey,
    }));
    const batch = await buildChargeProposals(ctx.db, charges);
    const single = await Promise.all(
      charges.map(
        async (charge) => (await buildChargeProposals(ctx.db, [charge]))[0]!,
      ),
    );
    const view = (proposals: typeof batch) =>
      Object.fromEntries(
        proposals.map((proposal) => [
          proposal.charge.chargeKey,
          [proposal.fingerprint, proposal.evidenceFingerprint],
        ]),
      );
    expect(batch).toHaveLength(4);
    expect(
      batch.flatMap(
        (proposal) =>
          proposal.judgment.spending?.candidates.map(
            (candidate) => candidate.purchaseId,
          ) ?? [],
      ),
    ).toContain(receipt.output.id);
    expect(view(batch)).toEqual(view(single));
    const generated = await generateStatementSuggestionPage(ctx.db, {
      after: null,
      runId: null,
    });
    expect(generated).toMatchObject({ published: batch.length, failed: [] });
    // Batching the initial publication must retain the exact evidence and
    // judgments that the single-charge review/apply path rebuilds.
    for (const proposal of single) {
      expect(
        await publishChargeProposal(ctx.db, proposal, {
          kind: "rule",
          model: null,
          revision: statementSuggestionsRepo.STATEMENT_SUGGESTION_REVISION,
          runId: null,
          evaluationId: null,
        }),
      ).toMatchObject({ outcome: "unchanged", labelsReused: 0 });
    }
  });

  // Failure modes: a re-export doubles the suggestion; an ignore recorded on
  // one observation leaves the other on the worklist; re-generation republishes
  // unchanged evidence.
  it("publishes one suggestion per charge and inherits decisions across observations", async () => {
    await card(ctx);
    const grocery = rowInput({
      providerTransactionId: "synthetic-grocery-record",
    });
    const coffee = rowInput({
      providerTransactionId: "synthetic-coffee-record",
      providerAmount: -6.25,
      merchant: "Example Cafe",
      rawDescription: "EXAMPLE CAFE",
      sourceCategory: "Coffee Shops",
    });
    await record(ctx, [grocery, coffee]);
    // Changed provider memos retain distinct observations of the same charges.
    await record(
      ctx,
      [
        {
          ...grocery,
          rowPosition: 10,
          providerNotes: "Synthetic reexport memo",
        },
        {
          ...coffee,
          rowPosition: 11,
          providerNotes: "Synthetic reexport memo",
        },
      ],
      { fingerprint: "fp-suggest-2" },
    );
    expect(
      await getSourceTransactionRecordSummary(ctx.db, {
        matchState: "unmatched",
      }),
    ).toMatchObject({ unmatched: 4, unmatchedCharges: 2 });

    expect(await generate(ctx)).toBe(2);
    expect(await generate(ctx)).toBe(0);
    const queue = await readWorkQueue(
      ctx.db,
      null,
      workQueueHouseholdInput.parse({ pageSize: 100 }),
      false,
    );
    // The household's Work has one row for the family, opening the
    // Suggestions page; the account's own Work counts its own.
    expect(
      queue.items.filter(
        (row) => row.suggestionFamily === "statement_transaction",
      ),
    ).toEqual([
      expect.objectContaining({
        entity: null,
        id: null,
        // A category rule is one vote: nothing is clean before a label.
        reason: "2 transaction suggestions (0 ready to accept)",
      }),
    ]);
    const [first] = (await suggestions(ctx)).filter(
      (row) => row.merchant === "Example Cafe",
    );
    expect(first).toMatchObject({ recommended: "create", clean: false });
    expect(first?.create?.kind).toBe("purchase");

    const rows = await listSourceTransactionRecords(ctx.db, {
      search: "EXAMPLE CAFE",
    });
    await updateSourceTransactionRecords(
      ctx.db,
      {
        selector: {
          source: "monarch",
          externalIds: [rows.data[0]!.externalId],
        },
        data: {
          disposition: "ignored",
          dispositionReason: "not_modeled",
          dispositionNote: "Synthetic coffee is not modeled.",
        },
      },
      ctx.actor,
    );
    expect(
      (
        await listSourceTransactionRecords(ctx.db, { search: "EXAMPLE CAFE" })
      ).data.map((row) => row.matchState),
    ).toEqual(["ignored", "ignored"]);
    // Reads follow the authoritative ignore; they never retire the advice.
    expect((await suggestions(ctx)).map((row) => row.merchant)).toEqual([
      "Example Grocer",
    ]);
    expect(await stateOf(ctx, first!.assessmentId)).toMatchObject({
      status: "pending",
      active: true,
    });
  });

  // A bounded key batch can contain only ignored identities; that must not
  // terminate discovery before later eligible charges or rewind its cursor.
  it("pages past ineligible charge identities and finishes after the last eligible charge", async () => {
    await card(ctx);
    await record(
      ctx,
      Array.from({ length: 6 }, (_, index) =>
        rowInput({
          providerTransactionId: `synthetic-bounded-charge-${index}`,
          providerAmount: -(20 + index),
        }),
      ),
    );
    const { rows } = await getDb(ctx.db).execute<{
      source: string;
      externalId: string;
      chargeKey: string;
    }>(sql`
      SELECT source,"externalId","chargeKey" FROM "SourceTransactionRecord"
      WHERE "deletedAt" IS NULL ORDER BY source,"chargeKey"`);
    await updateSourceTransactionRecords(
      ctx.db,
      {
        selector: {
          source: rows[0]!.source,
          externalIds: [0, 1, 3, 5].map((index) => rows[index]!.externalId),
        },
        data: {
          disposition: "ignored",
          dispositionReason: "not_modeled",
          dispositionNote: "Synthetic bounded selection.",
        },
      },
      ctx.actor,
    );
    expect(
      await statementSuggestionsRepo.countUnmatchedCharges(ctx.db, {}),
    ).toBe(2);
    const first = await generateStatementSuggestionPage(ctx.db, {
      runId: null,
      after: null,
      limit: 1,
    });
    expect(first).toMatchObject({
      processed: 1,
      failed: [],
      next: { source: rows[2]!.source, chargeKey: rows[2]!.chargeKey },
    });
    const second = await generateStatementSuggestionPage(ctx.db, {
      runId: null,
      after: first.next,
      limit: 1,
    });
    expect(second).toMatchObject({
      processed: 1,
      failed: [],
      next: { source: rows[4]!.source, chargeKey: rows[4]!.chargeKey },
    });
    expect(
      await generateStatementSuggestionPage(ctx.db, {
        runId: null,
        after: second.next,
        limit: 1,
      }),
    ).toMatchObject({ processed: 0, failed: [], next: null });
    expect((await suggestions(ctx)).map((row) => row.chargeKey).sort()).toEqual(
      [rows[2]!.chargeKey, rows[4]!.chargeKey].sort(),
    );
  });

  // Equal content in independent delta collections cannot inherit another
  // occurrence's settlement or ignore decision without an upstream identity.
  it.each(["settled", "ignored"] as const)(
    "keeps an identical ID-less delta observation actionable after the other is %s",
    async (decision) => {
      await card(ctx);
      const observed = rowInput({ rowPosition: 1 });
      await record(ctx, [observed], { fingerprint: "synthetic-idless-first" });
      const [first] = (await listSourceTransactionRecords(ctx.db, {})).data;
      await record(ctx, [observed], { fingerprint: "synthetic-idless-second" });
      const [second] = (
        await listSourceTransactionRecords(ctx.db, {
          importFingerprint: "synthetic-idless-second",
        })
      ).data;
      expect(second!.legacyExternalId).toBe(first!.legacyExternalId);
      expect(second!.chargeKey).not.toBe(first!.chargeKey);
      expect(second!.externalId).not.toBe(first!.externalId);
      await generate(ctx);
      const pending = await suggestions(ctx);
      expect(pending).toHaveLength(2);
      const reviewed = pending.find(
        (row) => row.chargeKey === first!.chargeKey,
      )!;
      if (decision === "settled") {
        await accept(ctx, reviewed);
      } else {
        await updateSourceTransactionRecords(
          ctx.db,
          {
            selector: {
              source: first!.source,
              externalIds: [first!.externalId],
            },
            data: {
              disposition: "ignored",
              dispositionReason: "not_modeled",
              dispositionNote: "Synthetic observation reviewed independently.",
            },
          },
          ctx.actor,
        );
      }
      await generate(ctx);
      const after = (await listSourceTransactionRecords(ctx.db, {})).data;
      expect(after.find((row) => row.id === first!.id)).toMatchObject({
        matchState: decision === "settled" ? "matched" : "ignored",
      });
      expect(after.find((row) => row.id === second!.id)).toMatchObject({
        matchState: "unmatched",
        transactionId: null,
        disposition: "open",
      });
      expect(await suggestions(ctx)).toMatchObject([
        { chargeKey: second!.chargeKey },
      ]);
    },
  );

  // Failure modes: the settlement-ref trigger supersedes the suggestion being
  // applied; a second accept creates a twin; the row stays unmatched.
  it("creates the transaction, ends applied, and refuses a replay", async () => {
    await card(ctx);
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const [suggestion] = await suggestions(ctx);
    const outcome = await accept(ctx, suggestion!);
    expect(outcome).toMatchObject({ status: "applied", applied: true });
    expect(await stateOf(ctx, suggestion!.assessmentId)).toMatchObject({
      status: "applied",
      active: true,
    });
    const [row] = (await listSourceTransactionRecords(ctx.db, {})).data;
    expect(row).toMatchObject({ matchState: "matched" });
    expect(row?.accountId).toMatch(/^FAC-/);
    await expect(accept(ctx, suggestion!)).rejects.toThrow(
      /already resolved|no longer pending/,
    );
    expect(await suggestions(ctx)).toEqual([]);
  });

  // Failure modes: a differently described transaction on the same day and
  // amount is missed and a twin is offered; a create is accepted while a
  // candidate is live.
  it("offers an attach across descriptors and only creates after the candidate is rejected", async () => {
    const account = (await card(ctx)).output;
    const existing = (
      await createRepoIdentity(ctx, "financialTransaction", {
        accountId: account.id,
        kind: "purchase",
        status: "posted",
        amount: 42.5,
        postedDate: "2026-05-05",
        merchant: "Older import label",
        rawDescription: "EXMPL GRCR #1 SYNTHETIC",
        sourceRefs: [],
      })
    ).output;
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const [suggestion] = await suggestions(ctx);
    expect(suggestion).toMatchObject({
      recommended: "attach",
      clean: false,
      candidates: [{ transactionId: existing.id, diff: ["postedDate"] }],
    });
    await expect(
      accept(ctx, suggestion!, { action: "create" }, true),
    ).rejects.toThrow(/must be rejected before creating/);
    await accept(ctx, suggestion!, {
      transactionId: existing.id,
      fields: ["postedDate"],
    });
    const [row] = (await listSourceTransactionRecords(ctx.db, {})).data;
    expect(row).toMatchObject({
      matchState: "matched",
      transactionId: existing.id,
    });
  });

  // Failure modes: two reviews racing on evidence that changed both succeed.
  it("refuses an accept after the evidence changed", async () => {
    const account = (await card(ctx)).output;
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const [suggestion] = await suggestions(ctx);
    // A new transaction appears nearby without the ref: the proposal is stale.
    await createRepoIdentity(ctx, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-04",
      merchant: "Example Grocer",
      rawDescription: "EXAMPLE GROCER 0001",
      sourceRefs: [],
    });
    await expect(accept(ctx, suggestion!)).rejects.toThrow(/evidence changed/);
    expect(await stateOf(ctx, suggestion!.assessmentId)).toMatchObject({
      status: "pending",
    });
  });

  // Failure modes: a dismissed charge returns on the next pass.
  it("keeps a dismissed charge dismissed", async () => {
    await card(ctx);
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const [suggestion] = await suggestions(ctx);
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: suggestion!.assessmentId,
      operationId: crypto.randomUUID(),
      verdict: "dismissed",
      correction: { present: false },
      intent: "history",
      suppression: {
        scope: "statement_transaction",
        candidateKey: `${suggestion!.source}:${suggestion!.chargeKey}`,
        fingerprint: suggestion!.fingerprint,
      },
    });
    expect(await suggestions(ctx)).toEqual([]);
    expect(await generate(ctx)).toBe(0);
    // Suppression belongs to retained history even after its projection retires.
    await getDb(ctx.db).execute(sql`UPDATE "AssessmentState" SET active = false
      WHERE id = ${suggestion!.assessmentId}::uuid`);
    expect(await generate(ctx)).toBe(0);
    expect(await suggestions(ctx)).toEqual([]);
  });

  // A same-amount posted twin must reuse the hold's booking and clear its work.
  it("supersedes a booked hold with its same-amount posted row", async () => {
    await card(ctx);
    await record(ctx, [
      rowInput({
        providerStatus: "pending",
        providerAmount: -40,
        statementDate: "2026-05-01",
        rawDescription: "EXAMPLE BISTRO PENDING",
        sourceCategory: "Restaurants & Bars",
      }),
    ]);
    await generate(ctx);
    const [hold] = await suggestions(ctx);
    expect(hold).toMatchObject({
      recommended: "create",
      providerStatus: "pending",
    });
    expect(hold?.create).toMatchObject({ status: "pending", postedDate: null });
    await accept(ctx, hold!);

    await record(
      ctx,
      [
        rowInput({
          providerAmount: -40,
          statementDate: "2026-05-03",
          rawDescription: "EXAMPLE BISTRO",
          sourceCategory: "Restaurants & Bars",
        }),
      ],
      { fingerprint: "fp-suggest-posted" },
    );
    await generate(ctx);
    const [posted] = await suggestions(ctx);
    expect(posted).toMatchObject({
      recommended: "supersede",
      clean: false,
      supersedeTransactionId: expect.stringMatching(/^FTX-/),
      // The hold's own pending refs never read as another charge's claim.
      candidates: [expect.objectContaining({ claimed: false })],
    });
    await accept(ctx, posted!);
    const states = Object.fromEntries(
      (await listSourceTransactionRecords(ctx.db, {})).data.map((row) => [
        row.rawDescription,
        row.matchState,
      ]),
    );
    expect(states).toEqual({
      "EXAMPLE BISTRO": "matched",
      "EXAMPLE BISTRO PENDING": "superseded",
    });
    expect(
      await getDb(ctx.db)
        .select({ cost: expense.cost })
        .from(expense)
        .where(notDeleted(expense)),
    ).toEqual([{ cost: 40 }]);
    expect(
      await getDb(ctx.db)
        .select({ amount: financialTransactionAllocation.amount })
        .from(financialTransactionAllocation)
        .where(notDeleted(financialTransactionAllocation)),
    ).toEqual([{ amount: 40 }]);
  });

  it("continues statement generation after an item publication failure with a stable retry frontier", async () => {
    await card(ctx);
    await record(
      ctx,
      Array.from({ length: 7 }, (_, index) =>
        rowInput({
          rawDescription: `SYNTHETIC GENERATION CHARGE ${index}`,
          providerAmount: -(index + 1),
        }),
      ),
    );
    const { rows: charges } = await getDb(ctx.db).execute<{
      source: string;
      chargeKey: string;
    }>(sql`
      SELECT source, "chargeKey"
      FROM "SourceTransactionRecord" WHERE "deletedAt" IS NULL ORDER BY source, "chargeKey"
    `);
    const removeFailure = await rejectStatementPublication(
      ctx,
      charges[0]!.chargeKey,
    );
    try {
      const first = await generateStatementSuggestionPage(ctx.db, {
        after: null,
        runId: null,
        limit: 5,
      });
      expect(first).toMatchObject({
        found: 5,
        processed: 5,
        published: 4,
        unchanged: 0,
        next: charges[4],
      });
      expect(first.failed).toHaveLength(1);
      expect(first.failed[0]!.message).toContain(
        "Synthetic statement publication failure",
      );
      const repeated = await generateStatementSuggestionPage(ctx.db, {
        after: null,
        runId: null,
        limit: 5,
      });
      expect(repeated).toMatchObject({
        found: 5,
        processed: 5,
        published: 0,
        unchanged: 4,
        next: first.next,
      });
      expect(repeated.failed).toHaveLength(1);
      const later = await generateStatementSuggestionPage(ctx.db, {
        after: first.next,
        runId: null,
        limit: 5,
      });
      expect(later).toMatchObject({
        found: 2,
        processed: 2,
        published: 2,
        failed: [],
        next: null,
      });
      await getDb(ctx.db).execute(
        sql`DELETE FROM "SyntheticStatementPublicationFailure"`,
      );
      const recovered = await retryStatementGenerationRefs(ctx.db, {
        runId: null,
        refs: first.failed.flatMap((failure) =>
          failure.ref ? [failure.ref] : [],
        ),
      });
      expect(recovered).toMatchObject({
        done: 1,
        skipped: 0,
        failed: [],
        published: 1,
        unchanged: 0,
      });
      expect(
        await retryStatementGenerationRefs(ctx.db, {
          runId: null,
          refs: first.failed.flatMap((failure) =>
            failure.ref ? [failure.ref] : [],
          ),
        }),
      ).toMatchObject({ done: 1, skipped: 0, failed: [] });
      const missing = await retryStatementGenerationRefs(ctx.db, {
        runId: null,
        refs: ["charge:synthetic:missing"],
      });
      expect(missing).toMatchObject({
        done: 0,
        skipped: 0,
        failed: [
          {
            ref: "charge:synthetic:missing",
            message: expect.stringContaining("not found"),
          },
        ],
      });
      expect(await suggestions(ctx)).toHaveLength(7);
    } finally {
      await removeFailure();
    }
  });

  it("recovers missed retirement even when settled transfer evidence produces no proposal", async () => {
    const account = (await card(ctx)).output;
    await record(ctx, [rowInput()]);
    await generateStatementSuggestionPage(ctx.db, { after: null, runId: null });
    const [pending] = await suggestions(ctx);
    const [observation] = (await listSourceTransactionRecords(ctx.db, {})).data;
    if (!pending || !observation)
      throw new Error("Missing synthetic recovery evidence");
    await createRepoIdentity(ctx, "financialTransaction", {
      accountId: account.id,
      kind: "account_transfer",
      status: "posted",
      amount: 42.5,
      transactionDate: "2026-05-04",
      postedDate: "2026-05-04",
      sourceRefs: [
        { source: observation.source, externalId: observation.externalId },
      ],
    });
    // Recreate only the stale projection a missed after-commit retirement left.
    await getDb(ctx.db)
      .update(assessmentState)
      .set({ active: true, status: "pending" })
      .where(eq(assessmentState.id, pending.assessmentId));
    const charge = {
      source: observation.source,
      chargeKey: observation.chargeKey,
    };
    expect(await buildChargeProposals(ctx.db, [charge])).toEqual([]);
    const other = await createRepoIdentity(ctx, "financialAccount", {
      name: "Synthetic other account",
      identity: { kind: "credit_card", network: "visa" },
      sourceAliases: [],
    });
    const outside = await retryStatementGenerationRefs(ctx.db, {
      runId: null,
      scope: {
        accountIds: [
          await resolveOrThrow(ctx.db, "financialAccount", other.output.id),
        ],
      },
      refs: [`charge:${charge.source}:${charge.chargeKey}`],
    });
    expect(outside).toMatchObject({
      done: 0,
      skipped: 1,
      failed: [],
      published: 0,
    });
    expect(
      await getDb(ctx.db)
        .select({ active: assessmentState.active })
        .from(assessmentState)
        .where(eq(assessmentState.id, pending.assessmentId)),
    ).toEqual([{ active: true }]);
    expect(
      await retryStatementGenerationRefs(ctx.db, {
        runId: null,
        refs: [`charge:${charge.source}:${charge.chargeKey}`],
      }),
    ).toMatchObject({ done: 1, skipped: 0, failed: [] });
    expect(
      await getDb(ctx.db)
        .select({
          active: assessmentState.active,
          status: assessmentState.status,
        })
        .from(assessmentState)
        .where(eq(assessmentState.id, pending.assessmentId)),
    ).toEqual([{ active: false, status: "superseded" }]);
    expect(
      await getDb(ctx.db).select({ cost: expense.cost }).from(expense),
    ).toEqual([]);
  });

  // Retired spending must not silently stay hidden when positive source
  // evidence returns; ordinary discovery owns the durable recovery review.
  it("publishes review when current evidence supports a retired transaction", async () => {
    const account = (await card(ctx)).output;
    await record(ctx, [
      rowInput({ providerTransactionId: "synthetic-reappeared-charge" }),
    ]);
    const [observation] = (await listSourceTransactionRecords(ctx.db, {})).data;
    if (!observation) throw new Error("Missing synthetic source observation");
    await createRepoIdentity(ctx, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "void",
      amount: 42.5,
      transactionDate: "2026-05-04",
      sourceRefs: [
        { source: observation.source, externalId: observation.externalId },
      ],
    });
    await generate(ctx);
    const rows = await suggestions(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clean: false,
      reviewReason: expect.any(String),
    });
    expect(
      await getDb(ctx.db)
        .select({ cost: expense.cost })
        .from(expense)
        .where(notDeleted(expense)),
    ).toEqual([]);
    await generate(ctx);
    expect(await suggestions(ctx)).toHaveLength(1);
  });

  // A refused lifecycle-only correction must survive the intake response as
  // ordinary review work, even when amount and booked money are unchanged.
  it("keeps a refused same-amount posted revision in durable review", async () => {
    await card(ctx);
    const source = rowInput({
      providerTransactionId: "synthetic-lifecycle-review",
      providerStatus: "pending",
    });
    await record(ctx, [source], { observedAt: "2026-06-01T00:00:00Z" });
    await generate(ctx);
    const [proposal] = await suggestions(ctx);
    if (!proposal) throw new Error("Missing synthetic booking proposal");
    await accept(ctx, proposal);
    const before = await getDb(ctx.db)
      .select({ cost: expense.cost })
      .from(expense)
      .where(notDeleted(expense));
    await record(
      ctx,
      [{ ...source, providerStatus: "posted", statementDate: "2026-05-05" }],
      {
        fingerprint: "synthetic-lifecycle-later",
        observedAt: "2026-06-02T00:00:00Z",
      },
    );
    await generate(ctx);
    expect(await suggestions(ctx)).toMatchObject([
      { clean: false, reviewReason: expect.any(String) },
    ]);
    expect(
      await getDb(ctx.db)
        .select({ cost: expense.cost })
        .from(expense)
        .where(notDeleted(expense)),
    ).toEqual(before);
  });

  // Partial exports do not establish source-confirmed absence or authorize voids.
  it("keeps a booked hold when a later partial export omits it", async () => {
    await card(ctx);
    await record(
      ctx,
      [
        rowInput({
          providerStatus: "pending",
          providerAmount: -300,
          statementDate: "2026-05-01",
          rawDescription: "EXAMPLE HOTEL HOLD",
          sourceCategory: "Travel & Vacation",
        }),
      ],
      { fingerprint: "fp-hold" },
    );
    await generate(ctx);
    const [hold] = await suggestions(ctx);
    await accept(ctx, hold!);
    await generate(ctx);
    expect(await suggestions(ctx)).toEqual([]);

    await record(
      ctx,
      [
        rowInput({
          statementDate: "2026-05-12",
          rawDescription: "EXAMPLE GROCER 0002",
        }),
      ],
      { fingerprint: "fp-later" },
    );
    await generateStatementSuggestionPage(ctx.db, { after: null, runId: null });
    expect(
      (await suggestions(ctx)).filter((row) => row.recommended === "void"),
    ).toEqual([]);
    const holds = await generateStatementHoldVoidPage(ctx.db, {
      after: null,
      runId: null,
      limit: 1,
    });
    expect(holds).toMatchObject({
      processed: 1,
      published: 0,
      next: expect.any(String),
    });
    expect(
      (await suggestions(ctx)).filter((row) => row.recommended === "void"),
    ).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select({
          status: financialTransaction.status,
          amount: financialTransaction.amount,
        })
        .from(financialTransaction)
        .where(notDeleted(financialTransaction)),
    ).toEqual([{ status: "pending", amount: 300 }]);
    expect(
      await getDb(ctx.db)
        .select({ cost: expense.cost })
        .from(expense)
        .where(notDeleted(expense)),
    ).toEqual([{ cost: 300 }]);
    expect(
      (await listSourceTransactionRecords(ctx.db, {})).data.find(
        (row) => row.rawDescription === "EXAMPLE HOTEL HOLD",
      ),
    ).toMatchObject({
      current: true,
      withdrawnAt: null,
      matchState: "matched",
    });
  });

  // Failure modes: a firmed-up descriptor from another export is two clean
  // creates, and bulk acceptance records the money twice.
  it("marks same-amount charges from another export as siblings, never clean", async () => {
    await card(ctx);
    await record(ctx, [rowInput({ rawDescription: "EXAMPLE MKTPLACE PMTS" })]);
    await record(
      ctx,
      [rowInput({ rawDescription: "EXAMPLE MKTPL*AB12CD34" })],
      { fingerprint: "fp-firmed" },
    );
    await generate(ctx);
    const rows = await suggestions(ctx);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => !row.clean && row.siblings === 1)).toBe(true);
  });

  // Matching statement labels must not replace the attach target's actual kind.
  it("keeps an attach to a non-spending transaction out of clean booking despite matching statement labels", async () => {
    const account = (await card(ctx)).output;
    await createRepoIdentity(ctx, "financialTransaction", {
      accountId: account.id,
      kind: "account_transfer",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-05",
      merchant: "Example Grocer",
      sourceRefs: [],
    });
    await record(ctx, [rowInput()]);
    await generate(ctx);
    await labelStatementSuggestions(ctx.db, {
      port: answering({ kind: "purchase", counterparty: "business" }),
      runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
    });
    const [proposal] = await suggestions(ctx);
    expect(proposal).toMatchObject({
      recommended: "attach",
      clean: false,
      spending: { status: "deferred" },
    });
    await expect(accept(ctx, proposal!)).rejects.toThrow(
      "kind or status cannot book this spending",
    );
  });

  // Failure modes: a model "same" leaves a descriptor-different attach
  // unreviewable in bulk; a label silently changes the evidence fingerprint
  // the apply step checks.
  it("labels attach candidates and lets a confident same-charge attach go in bulk", async () => {
    const account = (await card(ctx)).output;
    await createRepoIdentity(ctx, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-05",
      merchant: "Older import label",
      rawDescription: "EXMPL GRCR #1 SYNTHETIC",
      sourceRefs: [],
    });
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const [rule] = await suggestions(ctx);
    expect(rule).toMatchObject({ recommended: "attach", clean: false });
    expect(
      await labelStatementSuggestions(ctx.db, {
        port: answering({ kind: "purchase", counterparty: "business" }),
        runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
      }),
    ).toMatchObject({ labelled: 1 });
    const [labelled] = await suggestions(ctx);
    expect(labelled).toMatchObject({
      recommended: "attach",
      clean: true,
      candidates: [{ label: { same: "same", confidence: "high" } }],
    });
    expect(labelled!.model).not.toBeNull();
    expect(await stateOf(ctx, rule!.assessmentId)).toMatchObject({
      active: false,
    });
    // A rule pass over unchanged evidence keeps the labels.
    expect(await generate(ctx)).toBe(0);
    await accept(ctx, labelled!);
    expect(
      (await listSourceTransactionRecords(ctx.db, {})).data[0],
    ).toMatchObject({
      matchState: "matched",
    });
  });

  // A non-spending transfer needs labels, never a spending decision.
  it("finishes settlement-only labels without reserving spending allowance", async () => {
    const queue = captureBackgroundQueue();
    try {
      await card(ctx);
      await record(ctx, [
        rowInput({ providerStatus: "pending", sourceCategory: "Transfer" }),
      ]);
      await generate(ctx);
      const result = await runStatementLabels(ctx.db, {
        runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
        port: answering({ kind: "account_transfer", counterparty: "business" }),
        spendingAdvice: async () => {
          throw new Error(
            "Settlement-only evidence cannot request spending advice",
          );
        },
        decisionLimit: 2,
      });
      expect(result).toMatchObject({ labelled: 1, next: null, failed: [] });
    } finally {
      queue.restore();
    }
  });

  it("retains partial answers when merchant preparation defers on the response cache", async () => {
    await card(ctx);
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const until = new Date(Date.now() + 15_000);
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "background" });
    const first = await withJobFixtureExecution(
      ctx.db,
      {
        key: "synthetic.cache-progress",
        kind: "run.execute",
        input: {},
        recoveryTimeoutMs: 30 * 60_000,
      },
      async () => {
        const owner = currentJobExecution()!;
        const before = new Date(Date.now() - 60_000);
        await getDb(ctx.db)
          .update(job)
          .set({ lastUsefulProgressAt: before })
          .where(eq(job.id, owner.claim.id));
        const result = await runStatementLabels(ctx.db, {
          runId,
          cooperative: true,
          port: answering({ kind: "purchase", counterparty: "business" }),
          spendingAdvice: async () => {
            throw new Error("Synthetic merchant lookup", {
              cause: new JobDeferredError(
                "Synthetic cache contention",
                until,
                "provider_capacity",
              ),
            });
          },
        });
        const [saved] = await statementSuggestionsRepo.suggestionsNeedingLabels(
          ctx.db,
          1,
        );
        const checkpoint = saved!.checkpoint!;
        const readProgress = async () =>
          (
            await getDb(ctx.db)
              .select()
              .from(job)
              .where(eq(job.id, owner.claim.id))
          )[0]!.lastUsefulProgressAt;
        const committed = await readProgress();
        expect(committed!.getTime()).toBeGreaterThan(before.getTime());
        const subject = assessmentSubjects.statement_transaction.parse(
          saved!.subject,
        );
        const stale = structuredClone(checkpoint);
        stale.kind = false;
        stale.judgment.create!.votes.label = null;
        await statementSuggestionsRepo.recordStatementLabelCheckpoint(ctx.db, {
          charge: subject,
          evidenceFingerprint: saved!.evidenceFingerprint,
          checkpoint: stale,
        });
        expect(await readProgress()).toEqual(committed);
        expect(
          (
            await statementSuggestionsRepo.suggestionsNeedingLabels(ctx.db, 1)
          )[0]!.checkpoint,
        ).toMatchObject({ kind: true, counterparty: true });
        await statementSuggestionsRepo.recordStatementLabelCheckpoint(ctx.db, {
          charge: subject,
          evidenceFingerprint: saved!.evidenceFingerprint,
          checkpoint,
        });
        expect(await readProgress()).toEqual(committed);
        return result;
      },
    );
    expect(first).toMatchObject({
      completed: 0,
      failed: [],
      labels: { generated: 2 },
      waitingUntil: until.getTime(),
      next: { inclusive: true },
    });
    const resumed = await label(ctx, async () => {
      throw new Error("Durable answers must survive cache contention");
    });
    expect(resumed).toMatchObject({
      completed: 1,
      failed: [],
      labels: { generated: 1, reused: 2 },
    });
  });

  it("checkpoints unstarted spending after the cooperative page deadline", async () => {
    await card(ctx);
    await record(
      ctx,
      Array.from({ length: 33 }, (_, index) =>
        rowInput({
          rawDescription: `SYNTHETIC DEADLINE ${index}`,
          merchant: `Example deadline ${index}`,
          providerAmount: -100 - index,
        }),
      ),
    );
    await generate(ctx);
    let spendingCalls = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const first = await runStatementLabels(ctx.db, {
        runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
        cooperative: true,
        limit: 33,
        port: answering({ kind: "purchase", counterparty: "business" }),
        spendingAdvice: async () => {
          if (++spendingCalls === 32) vi.setSystemTime(Date.now() + 21_000);
          return financialSpendingAdvice.parse({});
        },
      });
      expect(spendingCalls).toBe(32);
      expect(first).toMatchObject({
        completed: 32,
        failed: [],
        next: { inclusive: true },
      });
      const pending = await statementSuggestionsRepo.suggestionsNeedingLabels(
        ctx.db,
        10,
        first.next,
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]!.checkpoint).toMatchObject({
        kind: true,
        counterparty: true,
        spending: false,
      });
    } finally {
      vi.useRealTimers();
    }
    const resumed = await label(ctx, async () => {
      throw new Error(
        "The next page must reuse its committed decision answers",
      );
    });
    expect(resumed).toMatchObject({
      completed: 1,
      failed: [],
      labels: { reused: 2, generated: 1 },
    });
  });

  it("durably defers cooperative spending finish after one gateway admission refusal", async () => {
    await card(ctx);
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "background" });
    let admissionAt = 0;
    let attempts = 0;
    const first = await runStatementLabels(ctx.db, {
      runId,
      cooperative: true,
      port: answering({ kind: "purchase", counterparty: "business" }),
      spendingAdvice: async () => {
        vi.useFakeTimers();
        admissionAt = Date.now();
        try {
          const pending = coordinatedGatewayRequest(
            {
              fetch: async () =>
                ++attempts === 1
                  ? new Response("Synthetic capacity refusal", {
                      status: 429,
                      headers: {
                        "x-cubby-admission-wait": "true",
                        "retry-after": "1",
                      },
                    })
                  : new Response("Synthetic admitted advice"),
            },
            "workers-ai",
            {
              endpoint: "responses",
              input: "https://gateway.internal/responses",
              init: { method: "POST", body: "{}" },
              headers: new Headers(),
              signal: undefined,
              query: async () => ({}),
            },
            {
              metadata: {
                environment: "production",
                feature: "synthetic-spending-admission",
                operation: "synthetic-spending-admission",
              },
            },
          ).then(
            (response) => ({ kind: "admitted" as const, response }),
            (error: unknown) => ({ kind: "rejected" as const, error }),
          );
          await vi.runAllTimersAsync();
          const outcome = await pending;
          if (outcome.kind === "rejected") throw outcome.error;
          await outcome.response.text();
          return financialSpendingAdvice.parse({});
        } finally {
          vi.useRealTimers();
        }
      },
    });
    expect(first).toMatchObject({
      labelled: 0,
      completed: 0,
      failed: [],
      labels: { generated: 2 },
    });
    expect(attempts).toBe(1);
    expect(first.waitingUntil).toBe(admissionAt + 1_000);
    expect(first.next).toMatchObject({ inclusive: true });
    const [saved] = await statementSuggestionsRepo.suggestionsNeedingLabels(
      ctx.db,
      1,
    );
    expect(saved!.checkpoint).toMatchObject({
      kind: true,
      counterparty: true,
      spending: false,
    });
    expect((await suggestions(ctx))[0]!.create!.votes.label).toBeNull();
    const resumed = await label(ctx, async () => {
      throw new Error(
        "Completed kind and counterparty answers must survive deferral",
      );
    });
    expect(resumed).toMatchObject({
      labelled: 1,
      completed: 1,
      failed: [],
      waitingUntil: null,
      labels: { generated: 1, reused: 2 },
    });
  });

  // A page cap must preserve every candidate and every completed decision,
  // including a partial charge whose remaining labels need another page.
  it.each([false, true])(
    "checkpoints high-fanout work across a changed candidate roster: %s",
    async (addCandidate) => {
      const queue = captureBackgroundQueue();
      try {
        const account = (await card(ctx)).output;
        for (let index = 0; index < 5; index++)
          await createRepoIdentity(ctx, "financialTransaction", {
            accountId: account.id,
            kind: "purchase",
            status: "posted",
            amount: 42.5,
            postedDate: "2026-05-05",
            rawDescription: `SYNTHETIC FANOUT CANDIDATE ${index}`,
            sourceRefs: [],
          });
        const observed = rowInput({
          providerTransactionId: "synthetic-checkpoint-record",
        });
        await record(ctx, [observed]);
        await generate(ctx);
        const runId = await ensureRun(ctx.db, ctx.actor, {
          purpose: "background",
        });
        const seen: string[] = [];
        const answer = answering({
          kind: "purchase",
          counterparty: "business",
        });
        let pageCalls = 0;
        const port: DecisionPort = async (input) => {
          pageCalls++;
          seen.push(JSON.stringify(input));
          return answer(input);
        };
        let outcome = await labelStatementSuggestions(ctx.db, {
          runId,
          port,
          decisionLimit: 3,
        });
        expect(pageCalls).toBeLessThanOrEqual(3);
        expect(outcome.next).not.toBeNull();
        expect(outcome.labelled).toBe(0);
        if (addCandidate)
          await createRepoIdentity(ctx, "financialTransaction", {
            accountId: account.id,
            kind: "purchase",
            status: "posted",
            amount: 42.5,
            postedDate: "2026-05-05",
            rawDescription: "SYNTHETIC LATER CANDIDATE",
            sourceRefs: [],
          });
        await record(
          ctx,
          [
            {
              ...observed,
              rowPosition: 20,
              providerNotes: "Synthetic checkpoint memo",
            },
          ],
          { fingerprint: "synthetic-checkpoint-reexport" },
        );
        await generate(ctx);
        for (let page = 0; page < 10 && outcome.next !== null; page++) {
          pageCalls = 0;
          outcome = await labelStatementSuggestions(ctx.db, {
            runId,
            port,
            after: outcome.next,
            decisionLimit: 3,
          });
          expect(pageCalls).toBeLessThanOrEqual(3);
          expect(outcome.failed).toEqual([]);
        }
        expect(outcome.next).toBeNull();
        const candidates = addCandidate ? 6 : 5;
        expect(seen).toHaveLength(candidates + 2);
        expect(new Set(seen).size).toBe(candidates + 2);
        const [complete] = await suggestions(ctx);
        expect(complete!.candidates).toHaveLength(candidates);
        expect(
          complete!.candidates.every((candidate) => candidate.label !== null),
        ).toBe(true);
        expect(complete!.create).toMatchObject({
          votes: { label: "purchase" },
          counterparty: { label: "business" },
        });
      } finally {
        queue.restore();
      }
    },
  );

  // Observation-only evidence churn must not discard paid labels or ask the
  // model again; the rebuilt judgment still uses the current evidence fence.
  it("keeps labels across a re-Sweep with unchanged model inputs", async () => {
    await card(ctx);
    const observed = rowInput({
      providerTransactionId: "synthetic-reused-label-record",
    });
    await record(ctx, [observed]);
    await generate(ctx);
    await label(ctx, answering({ kind: "purchase", counterparty: "business" }));
    const [before] = await suggestions(ctx);
    expect(before).toMatchObject({
      clean: true,
      create: {
        votes: { label: "purchase" },
        counterparty: { label: "business" },
      },
    });
    await record(
      ctx,
      [{ ...observed, rowPosition: 10, providerNotes: "Synthetic memo" }],
      {
        fingerprint: "synthetic-reexport",
      },
    );
    const regenerated = await generateStatementSuggestionPage(ctx.db, {
      after: null,
      runId: null,
    });
    expect(regenerated).toMatchObject({ processed: 1, labelsReused: 2 });
    let calls = 0;
    const outcome = await label(ctx, async () => {
      calls++;
      throw new Error("Unchanged model inputs must not be labelled again");
    });
    expect(calls).toBe(0);
    expect(outcome).toMatchObject({ labelled: 0, failed: [] });
    const [after] = await suggestions(ctx);
    expect(after).toMatchObject({
      clean: true,
      create: {
        votes: { label: "purchase" },
        counterparty: { label: "business" },
        notes: "Synthetic memo",
      },
      model: before!.model,
    });
    await accept(ctx, after!);
    expect(
      (await listSourceTransactionRecords(ctx.db, {})).data.every(
        (row) => row.matchState === "matched",
      ),
    ).toBe(true);
  });

  // Prompt instructions are model inputs too; an obsolete producer revision
  // cannot be kept merely because the charge's evidence fingerprint matches.
  it("relabels an obsolete prompt revision even when evidence is unchanged", async () => {
    await card(ctx);
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const [existing] = await suggestions(ctx);
    const [proposal] = await buildChargeProposals(ctx.db, [
      { source: existing!.source, chargeKey: existing!.chargeKey },
    ]);
    const judgment = structuredClone(proposal!.judgment);
    judgment.create!.votes.label = "purchase";
    judgment.create!.counterparty.label = "business";
    judgment.clean = true;
    await publishChargeProposal(
      ctx.db,
      await labelledProposal(proposal!, judgment),
      {
        kind: "model",
        model: "synthetic-decision-model",
        revision: "synthetic-obsolete-prompt",
        runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
        evaluationId: null,
      },
    );
    const [publishedCheckpoint] = await getDb(ctx.db)
      .select({ data: assessmentState.data })
      .from(assessmentState)
      .where(
        and(
          eq(assessmentState.family, "statement_transaction"),
          eq(assessmentState.active, true),
        ),
      );
    expect(publishedCheckpoint?.data).toMatchObject({
      labelCheckpoint: { models: ["synthetic-decision-model"] },
    });
    await generate(ctx);
    const [rebuilt] = await suggestions(ctx);
    expect(rebuilt).toMatchObject({
      model: null,
      clean: false,
      create: { votes: { label: null }, counterparty: { label: null } },
    });
    expect(
      await label(
        ctx,
        answering({ kind: "purchase", counterparty: "business" }),
      ),
    ).toMatchObject({ labelled: 1 });
  });

  // Both statement inputs and the candidate identity set participate in label
  // validity; retaining a previous clean result would permit stale bulk advice.
  it.each(["statement", "candidates"] as const)(
    "retires labels when %s model inputs change",
    async (changed) => {
      const account = (await card(ctx)).output;
      await createRepoIdentity(ctx, "financialTransaction", {
        accountId: account.id,
        kind: "purchase",
        status: "posted",
        amount: 42.5,
        postedDate: "2026-05-05",
        rawDescription: "SYNTHETIC PREVIOUS CANDIDATE",
        sourceRefs: [],
      });
      const observed = rowInput({
        providerTransactionId: "synthetic-model-input-record",
      });
      await record(ctx, [observed]);
      await generate(ctx);
      await label(
        ctx,
        answering({ kind: "purchase", counterparty: "business" }),
      );
      if (changed === "statement") {
        await record(
          ctx,
          [
            {
              ...observed,
              rowPosition: 10,
              merchant: "Example Changed Merchant",
            },
          ],
          { fingerprint: "synthetic-changed-subject" },
        );
      } else {
        await createRepoIdentity(ctx, "financialTransaction", {
          accountId: account.id,
          kind: "purchase",
          status: "posted",
          amount: 42.5,
          postedDate: "2026-05-05",
          rawDescription: "SYNTHETIC ADDITIONAL CANDIDATE",
          sourceRefs: [],
        });
      }
      await generate(ctx);
      const [rebuilt] = await suggestions(ctx);
      expect(rebuilt).toMatchObject({
        model: null,
        clean: false,
        create: { votes: { label: null }, counterparty: { label: null } },
      });
      expect(
        rebuilt!.candidates.every((candidate) => candidate.label === null),
      ).toBe(true);
      expect(
        await label(
          ctx,
          answering({ kind: "purchase", counterparty: "business" }),
        ),
      ).toMatchObject({ labelled: 1 });
    },
  );

  // The production adapter must receive multi-question Jev/Clef requests;
  // a DecisionPort bypasses that consolidation and cannot detect this failure.
  it("consolidates a label page through the shared model transport", async () => {
    await card(ctx);
    await record(
      ctx,
      Array.from({ length: 8 }, (_, index) =>
        rowInput({
          merchant: `Example Batch Merchant ${index}`,
          rawDescription: `SYNTHETIC BATCH ${index}`,
          providerAmount: -200 - index,
        }),
      ),
    );
    await generate(ctx);
    await activateAiRefresh(ctx.db, "synthetic-batch-release", {
      enabled: true,
      manifest: {},
      startDiscovery: false,
    });
    const requests: number[] = [];
    const peer = vi.spyOn(cfEnv, "getTestAiGateway").mockReturnValue({
      fetch: async (_url, init) => {
        const input: {
          questions: Record<string, { criteria: Record<string, string> }>;
        } = JSON.parse(String(init?.body));
        requests.push(Object.keys(input.questions).length);
        return Response.json({
          result: {
            answers: Object.fromEntries(
              Object.entries(input.questions).map(([id, question]) => {
                const entries = Object.entries(question.criteria);
                const choice =
                  entries.find(
                    ([, value]) => value === "purchase" || value === "business",
                  )?.[0] ?? entries[0]![0];
                return [
                  id,
                  {
                    type: "choice",
                    choice,
                    confidence: 1,
                    probabilities: Object.fromEntries(
                      entries.map(([key]) => [key, key === choice ? 1 : 0]),
                    ),
                  },
                ];
              }),
            ),
          },
        });
      },
    });
    try {
      const outcome = await labelStatementSuggestions(ctx.db, {
        runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
      });
      expect(outcome).toMatchObject({
        labelled: 8,
        failed: [],
        labels: { generated: 24 },
      });
      expect(requests.reduce((total, questions) => total + questions, 0)).toBe(
        16,
      );
      expect(Math.max(...requests)).toBeGreaterThan(1);
      expect(requests.length).toBeLessThan(16);
      expect(
        (await suggestions(ctx)).every(
          (row) =>
            row.create?.votes.label === "purchase" &&
            row.create.counterparty.label === "business",
        ),
      ).toBe(true);
    } finally {
      peer.mockRestore();
    }
  });

  it("batches spending-category decisions after statement classification", async () => {
    await card(ctx);
    await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic Category Merchant",
    });
    await record(
      ctx,
      Array.from({ length: 8 }, (_, index) =>
        rowInput({
          merchant: "Synthetic Category Merchant",
          rawDescription: `SYNTHETIC CATEGORY ${index}`,
          providerAmount: -300 - index,
        }),
      ),
    );
    await generate(ctx);
    await activateAiRefresh(ctx.db, "synthetic-spending-category-batch", {
      enabled: true,
      manifest: {},
      startDiscovery: false,
    });
    const requests: number[] = [];
    const peer = vi.spyOn(cfEnv, "getTestAiGateway").mockReturnValue({
      fetch: async (url, init) => {
        if (String(url).includes("models.dev")) return Response.json({});
        const input: {
          questions: Record<string, { criteria: Record<string, string> }>;
        } = JSON.parse(String(init?.body));
        const metadata = JSON.parse(
          new Headers(init?.headers).get("cf-aig-metadata") ?? "{}",
        );
        if (metadata.feature === "field-suggestion")
          requests.push(Object.keys(input.questions).length);
        return Response.json({
          result: {
            answers: Object.fromEntries(
              Object.entries(input.questions).map(([id, question]) => {
                const entries = Object.entries(question.criteria);
                const choice =
                  entries.find(
                    ([, label]) => label === "purchase" || label === "business",
                  )?.[0] ?? entries[0]![0];
                return [
                  id,
                  {
                    type: "choice",
                    choice,
                    confidence: 1,
                    probabilities: Object.fromEntries(
                      entries.map(([key]) => [key, key === choice ? 1 : 0]),
                    ),
                  },
                ];
              }),
            ),
          },
        });
      },
    });
    try {
      const outcome = await runStatementLabels(ctx.db, {
        runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
      });
      expect(outcome).toMatchObject({ labelled: 8, failed: [] });
      expect(requests.reduce((total, count) => total + count, 0)).toBe(8);
      expect(Math.max(...requests)).toBeGreaterThan(1);
      expect(requests.length).toBeLessThan(8);
      const category = await getDb(ctx.db).query.spendingCategory.findFirst({
        where: eq(spendingCategory.name, "Synthetic statement spending"),
      });
      if (!category) throw new Error("Synthetic spending category is missing");
      const labelled = await suggestions(ctx);
      expect(labelled).toHaveLength(8);
      expect(
        labelled.every(
          (row) =>
            row.create?.votes.label === "purchase" &&
            row.create.counterparty.label === "business" &&
            row.spending?.request.advice?.spendingCategoryId ===
              category.shortcode,
        ),
      ).toBe(true);
    } finally {
      peer.mockRestore();
    }
  });

  // A single charge's identity shortlist must not keep its own four-call cap.
  it("fans out every candidate identity decision in one charge", async () => {
    const account = (await card(ctx)).output;
    for (let index = 0; index < 8; index++)
      await createRepoIdentity(ctx, "financialTransaction", {
        accountId: account.id,
        kind: "purchase",
        status: "posted",
        amount: 42.5,
        postedDate: "2026-05-05",
        merchant: `Example Candidate ${index}`,
        rawDescription: `SYNTHETIC CANDIDATE ${index}`,
        sourceRefs: [],
      });
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const answer = answering({ kind: "purchase", counterparty: "business" });
    let active = 0;
    let peak = 0;
    const pending = labelStatementSuggestions(ctx.db, {
      port: async (input) => {
        peak = Math.max(peak, ++active);
        started.resolve();
        await release.promise;
        try {
          return await answer(input);
        } finally {
          active--;
        }
      },
      runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
    });
    try {
      await started.promise;
      await new Promise((resolve) => setTimeout(resolve, 100));
      release.resolve();
      expect((await pending).failed).toEqual([]);
      expect(peak).toBeGreaterThan(4);
    } finally {
      release.resolve();
      await pending;
    }
  });

  // Model fan-out must fill the gateway independently of pooled publishing.
  // An unresolved model answer must not hold a transaction, and a burst of
  // returned answers must still open at most four publish transactions.
  it("fans out a label page while bounding DB publication independently", async () => {
    await card(ctx);
    await record(
      ctx,
      Array.from({ length: 168 }, (_, index) =>
        rowInput({
          merchant: `Example Merchant ${index}`,
          rawDescription: `SYNTHETIC CHARGE ${index}`,
          providerAmount: -100 - index,
        }),
      ),
    );
    await generate(ctx);
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const answer = answering({ kind: "purchase", counterparty: "business" });
    let spendingActive = 0;
    let spendingPeak = 0;
    const spendingAdvice = await statementSpendingAdvice(ctx.db);
    let modelActive = 0;
    let modelPeak = 0;
    let publishActive = 0;
    let publishPeak = 0;
    const publish = assessmentRepo.publishAssessments;
    const releasePublications = Promise.withResolvers<void>();
    const renewalStarted = Promise.withResolvers<number>();
    let publicationDb: Parameters<typeof publish>[0] | undefined;
    let claim:
      | NonNullable<ReturnType<typeof currentJobExecution>>["claim"]
      | undefined;
    let renewal: Promise<boolean> | undefined;
    let renewalQueued = false;
    let publicationsAfterQueue = 0;
    const batchSizes: number[] = [];
    const spy = vi
      .spyOn(assessmentRepo, "publishAssessments")
      .mockImplementation(async (...args) => {
        publishPeak = Math.max(publishPeak, ++publishActive);
        batchSizes.push(args[1].length);
        publicationDb ??= args[0];
        claim ??= currentJobExecution()?.claim;
        if (renewalQueued) publicationsAfterQueue++;
        try {
          await releasePublications.promise;
          return await publish(...args);
        } finally {
          publishActive--;
        }
      });
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "background" });
    const pending = withJobFixtureExecution(
      ctx.db,
      {
        key: "synthetic.label-fanout-real-job",
        kind: "synthetic.label-fanout",
        input: {},
      },
      () =>
        runStatementLabels(ctx.db, {
          port: async (input) => {
            modelPeak = Math.max(modelPeak, ++modelActive);
            started.resolve();
            await release.promise;
            try {
              return await answer(input);
            } finally {
              modelActive--;
            }
          },
          runId,
          limit: 168,
          spendingAdvice: async (input) => {
            spendingPeak = Math.max(spendingPeak, ++spendingActive);
            try {
              return await spendingAdvice!(input);
            } finally {
              spendingActive--;
            }
          },
        }),
    );
    try {
      await started.promise;
      // Model answers remain outstanding while the complete page fans out.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(publishActive).toBe(0);
      release.resolve();
      await expect.poll(() => publishActive).toBe(4);
      const owner = claim;
      const held = publicationDb;
      if (!owner || !held) throw new Error("Expected real Job publications");
      renewal = databaseHelpers.withTransactionDatabase(ctx.db, async (tx) => {
        const pid = await getDb(tx).execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`,
        );
        const controlPid = pid.rows[0]?.pid;
        if (!controlPid) throw new Error("Expected renewal connection");
        renewalStarted.resolve(controlPid);
        return renewJob(tx, owner);
      });
      renewal.catch(renewalStarted.reject);
      const renewalPid = await renewalStarted.promise;
      // Observe through a held publication connection: four holders plus the
      // renewal already occupy the five-connection production pool shape.
      await expect
        .poll(async () => {
          const waiting = await getDb(held).execute<{
            waiting: boolean;
          }>(sql`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE pid = ${renewalPid}::int
            AND cardinality(pg_blocking_pids(pid)) > 0
        ) AS waiting`);
          return waiting.rows[0]?.waiting;
        })
        .toBe(true);
      renewalQueued = true;
      releasePublications.resolve();
      const outcome = await pending;
      expect(await renewal).toBe(true);
      expect(publicationsAfterQueue).toBe(2);
      expect(modelPeak).toBeGreaterThanOrEqual(30);
      expect(spendingPeak).toBeGreaterThan(1);
      expect(spendingPeak).toBeLessThanOrEqual(32);
      expect(outcome).toMatchObject({
        labelled: 168,
        labels: { generated: 504 },
      });
      expect(publishPeak).toBeGreaterThan(1);
      expect(publishPeak).toBeLessThanOrEqual(4);
      expect(batchSizes.sort((a, b) => a - b)).toEqual([8, 32, 32, 32, 32, 32]);
    } finally {
      release.resolve();
      releasePublications.resolve();
      await pending;
      await renewal;
      spy.mockRestore();
    }
  });

  it("returns committed label counts when a cooperative page pauses mid-page", async () => {
    await card(ctx);
    await record(ctx, [
      rowInput(),
      rowInput({
        rawDescription: "SYNTHETIC SECOND CHARGE",
        merchant: "Example Cafe",
        providerAmount: -12,
      }),
    ]);
    await generate(ctx);
    const paused = new AiBudgetExhaustedError(
      {
        windowStart: "2026-05-04T00:00:00Z",
        windowEnd: "2026-05-04T06:00:00Z",
        credit: { limitUsd: 1, spentUsd: 0 },
        plan: { limitUsd: 1, spentUsd: 0 },
        paid: { limitUsd: 1, spentUsd: 1 },
      },
      "Synthetic pause",
    );
    const answer = answering({ kind: "purchase", counterparty: "business" });
    expect(
      await labelStatementSuggestions(ctx.db, {
        cooperative: true,
        port: async (input) => {
          if (input.state.includes("SYNTHETIC SECOND CHARGE")) throw paused;
          return answer(input);
        },
        runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
      }),
    ).toMatchObject({
      labelled: 1,
      paused: { reason: paused.message, until: paused.resumeAt },
    });
  });

  // A member resolving listed work is a successful competing outcome, not a label failure.
  it("batches no-action receipts across a charge accepted while labels are in flight", async () => {
    await card(ctx);
    for (const index of [0, 1, 2]) {
      await record(
        ctx,
        [
          rowInput({
            providerTransactionId: `synthetic-accepted-gap-${index}`,
            rawDescription: `SYNTHETIC ACCEPTED GAP ${index}`,
            providerAmount: -20 - index,
          }),
        ],
        { fingerprint: `synthetic-accepted-gap-${index}` },
      );
      await generate(ctx);
    }
    const pending = (await suggestions(ctx)).find(
      (row) => row.rawDescription === "SYNTHETIC ACCEPTED GAP 1",
    );
    const answer = answering({ kind: "purchase", counterparty: "person" });
    const prefix = vi.spyOn(
      statementSuggestionsRepo,
      "completeNoActionStatementPrefix",
    );
    let accepted = false;
    try {
      const result = await label(ctx, async (input) => {
        if (!accepted) {
          accepted = true;
          await accept(ctx, pending!);
        }
        return answer(input);
      });
      expect(result).toMatchObject({ completed: 2, labelled: 2, failed: [] });
      expect(prefix.mock.calls.map(([, entries]) => entries.length)).toEqual([
        2,
      ]);
      expect(
        await statementSuggestionsRepo.countSuggestionsNeedingLabels(ctx.db),
      ).toBe(0);
      expect(
        await getDb(ctx.db).select().from(financialTransaction),
      ).toHaveLength(1);
    } finally {
      prefix.mockRestore();
    }
  });

  it.each(["unscoped", "account/date", "import"])(
    "completes no-action labels with %s scope and preserves its admission path",
    async (mode) => {
      const account = (await card(ctx)).output;
      const importScoped = mode === "import";
      const recorded = await record(ctx, [
        rowInput(),
        rowInput({
          providerAmount: -19,
          rawDescription: "SYNTHETIC PERSONAL PAYMENT",
        }),
      ]);
      await generate(ctx);
      const admission = vi.spyOn(
        automaticRuleRuntime,
        "applyAutomaticRulesForCharge",
      );
      try {
        expect(
          await labelStatementSuggestions(ctx.db, {
            port: answering({ kind: "purchase", counterparty: "person" }),
            runId: await ensureRun(ctx.db, ctx.actor, {
              purpose: "background",
            }),
            scope: importScoped
              ? { importId: recorded.batchId }
              : mode === "account/date"
                ? {
                    accountIds: [
                      await resolveOrThrow(
                        ctx.db,
                        "financialAccount",
                        account.id,
                      ),
                    ],
                    since: "2026-05-01",
                  }
                : {},
          }),
        ).toMatchObject({
          completed: 2,
          failed: [],
          next: null,
        });
        expect(admission).toHaveBeenCalledTimes(importScoped ? 2 : 0);
        expect(
          await statementSuggestionsRepo.countSuggestionsNeedingLabels(ctx.db),
        ).toBe(0);
        expect(await getDb(ctx.db).select().from(financialTransaction)).toEqual(
          [],
        );
      } finally {
        admission.mockRestore();
      }
    },
  );

  it("rereads a replaced no-action suffix and preserves its evidence refusal after an earlier attachment", async () => {
    await enableStatementAttach(ctx);
    const account = (await card(ctx)).output;
    for (const amount of [21, 25])
      await createRepoIdentity(ctx, "financialTransaction", {
        accountId: account.id,
        kind: "purchase",
        status: "posted",
        amount,
        postedDate: amount === 21 ? "2026-05-05" : "2026-06-05",
        merchant: "Example Grocer",
        rawDescription: `SYNTHETIC EXISTING ${amount}`,
        sourceRefs: [],
      });
    const suffix = rowInput({
      providerTransactionId: "synthetic-prefix-suffix",
      providerAmount: -24,
      statementDate: "2026-06-04",
      rawDescription: "SYNTHETIC PREFIX SUFFIX",
    });
    for (const [index, source] of [
      rowInput({
        providerAmount: -18,
        statementDate: "2026-04-04",
        rawDescription: "SYNTHETIC PREFIX LEADING",
      }),
      rowInput({
        providerAmount: -21,
        rawDescription: "SYNTHETIC PREFIX BOOKING",
      }),
      suffix,
    ].entries()) {
      await record(ctx, [source], { fingerprint: `synthetic-prefix-${index}` });
      await generate(ctx);
    }
    const apply = automaticRuleRuntime.applyAutomaticRulesForCharge;
    let replaced = false;
    const admission = vi
      .spyOn(automaticRuleRuntime, "applyAutomaticRulesForCharge")
      .mockImplementation(async (...args) => {
        const outcome = await apply(...args);
        if (outcome.applied.length && !replaced) {
          replaced = true;
          const old = (await suggestions(ctx)).find(
            (row) => row.rawDescription === suffix.rawDescription,
          )!;
          if (!old) throw new Error("Expected the original suffix publication");
          await record(ctx, [{ ...suffix, providerAmount: -25 }], {
            fingerprint: "synthetic-prefix-correction",
          });
          await statementSuggestionsRepo.regenerateCharges(ctx.db, [
            { source: old.source, chargeKey: old.chargeKey },
          ]);
          // A concurrent refresh settles the replacement through real publication/application.
          await label(
            ctx,
            answering({ kind: "purchase", counterparty: "business" }),
          );
          const [retained] = await getDb(ctx.db)
            .select()
            .from(assessmentState)
            .where(eq(assessmentState.id, old.assessmentId));
          if (retained?.active)
            throw new Error("Expected the old suffix receipt to be retired");
        }
        return outcome;
      });
    try {
      const personal = answering({ kind: "purchase", counterparty: "person" });
      const business = answering({
        kind: "purchase",
        counterparty: "business",
      });
      const result = await labelStatementSuggestions(ctx.db, {
        scope: {
          accountIds: [
            await resolveOrThrow(ctx.db, "financialAccount", account.id),
          ],
          since: "2026-04-01",
        },
        port: (input) =>
          input.state.includes("SYNTHETIC PREFIX BOOKING")
            ? business(input)
            : personal(input),
      });
      expect(result).toMatchObject({ completed: 3, next: null });
      // The ordinary path also refuses this obsolete evidence in its later
      // rebuild round. Completing a no-action prefix must not bypass that fence.
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.message).toContain(
        "lost its active evidence fence",
      );
      expect(replaced).toBe(true);
      expect(admission).toHaveBeenCalledTimes(3);
      const booked = await getDb(ctx.db)
        .select({ amount: financialTransaction.amount })
        .from(financialTransaction)
        .orderBy(financialTransaction.amount);
      expect(booked).toEqual([{ amount: 21 }, { amount: 25 }]);
      expect(
        await statementSuggestionsRepo.countSuggestionsNeedingLabels(ctx.db),
      ).toBe(0);
    } finally {
      admission.mockRestore();
    }
  });

  it("drains only the exact no-action receipt prefix and rolls completion back atomically", async () => {
    await card(ctx);
    await record(
      ctx,
      [0, 1, 2, 3].map((index) =>
        rowInput({
          providerAmount: -20 - index,
          rawDescription: `SYNTHETIC PREFIX ${index}`,
        }),
      ),
    );
    await generate(ctx);
    const entries = await completeLabelPublications(ctx);
    const results =
      await statementSuggestionsRepo.publishCompleteStatementLabels(
        ctx.db,
        entries,
      );
    const targets = entries.map((entry) => {
      const result = results.get(
        statementSuggestionsRepo.chargeId(entry.proposal.charge),
      );
      if (result?.kind !== "ready")
        throw new Error("Expected retained synthetic receipt");
      return {
        assessmentId: result.receipt.assessmentId,
        charge: entry.proposal.charge,
        evidenceFingerprint: result.receipt.evidenceFingerprint,
      };
    });
    const ids = targets.map((entry) => entry.assessmentId);
    await databaseHelpers.withTransactionDatabase(ctx.db, async (tx) => {
      await transitionAssessmentStates(
        tx,
        inArray(assessmentState.id, ids),
        (row) => ({
          data: {
            ...z.record(z.string(), z.json()).parse(row.data),
            matchedRules:
              row.id === targets[2]!.assessmentId
                ? ["statement_transaction.attach@synthetic"]
                : row.id === targets[1]!.assessmentId
                  ? [ruleBase("statement_transaction.book_spending")]
                  : row.id === targets[3]!.assessmentId
                    ? ["statement_transaction.book_spending@synthetic-obsolete"]
                    : [],
          },
        }),
        { kind: "synthetic_prefix_setup" },
      );
    });
    await setAutomaticRule(ctx.db, ctx.actor, {
      ruleKey: "statement_transaction.attach",
      enabled: false,
    });
    const read = () =>
      getDb(ctx.db)
        .select()
        .from(assessmentState)
        .where(inArray(assessmentState.id, ids))
        .orderBy(assessmentState.id);
    const before = await read();
    const eventsBefore = await getDb(ctx.db)
      .select()
      .from(feedback)
      .orderBy(feedback.id);
    await expect(
      databaseHelpers.withTransactionDatabase(ctx.db, async (tx) => {
        expect(
          await statementSuggestionsRepo.completeNoActionStatementPrefix(
            tx,
            targets,
          ),
        ).toBe(2);
        throw new Error("Synthetic outer rollback");
      }),
    ).rejects.toThrow("Synthetic outer rollback");
    expect(await read()).toEqual(before);
    expect(
      await getDb(ctx.db).select().from(feedback).orderBy(feedback.id),
    ).toEqual(eventsBefore);
    expect(
      await statementSuggestionsRepo.completeNoActionStatementPrefix(ctx.db, [
        { ...targets[0]!, evidenceFingerprint: "synthetic obsolete evidence" },
        ...targets.slice(1),
      ]),
    ).toBe(0);
    expect(
      await statementSuggestionsRepo.completeNoActionStatementPrefix(
        ctx.db,
        targets,
      ),
    ).toBe(2);
    const after = await read();
    for (const [index, target] of targets.entries()) {
      const row = after.find((row) => row.id === target.assessmentId)!;
      expect(
        z.record(z.string(), z.json()).parse(row.data).applicationPending,
      ).toBe(index < 2 ? undefined : true);
    }
    // A paused rule is still a boundary; suffix receipts remain for the ordinary path.
    expect(
      await statementSuggestionsRepo.completeNoActionStatementPrefix(
        ctx.db,
        targets.slice(2),
      ),
    ).toBe(0);
    expect(
      await statementSuggestionsRepo.completeNoActionStatementPrefix(
        ctx.db,
        targets,
      ),
    ).toBe(0);
    // An obsolete import-only stamp is not proof of the current execution contract.
    expect(
      await statementSuggestionsRepo.completeNoActionStatementPrefix(
        ctx.db,
        targets.slice(3),
      ),
    ).toBe(0);
    expect(await getDb(ctx.db).select().from(financialTransaction)).toEqual([]);
  });

  it.each(["cancelled", "expired"] as const)(
    "fences no-action receipt completion under %s Job ownership",
    async (failure) => {
      await card(ctx);
      await record(ctx, [rowInput()]);
      await generate(ctx);
      const entries = await completeLabelPublications(ctx);
      const outcomes =
        await statementSuggestionsRepo.publishCompleteStatementLabels(
          ctx.db,
          entries,
        );
      const entry = entries[0]!;
      const outcome = outcomes.get(
        statementSuggestionsRepo.chargeId(entry.proposal.charge),
      );
      if (outcome?.kind !== "ready")
        throw new Error("Expected synthetic pending receipt");
      const targets = [
        {
          assessmentId: outcome.receipt.assessmentId,
          charge: entry.proposal.charge,
          evidenceFingerprint: outcome.receipt.evidenceFingerprint,
        },
      ];
      const before = await getDb(ctx.db)
        .select()
        .from(assessmentState)
        .where(eq(assessmentState.id, targets[0]!.assessmentId));
      const beforeEvents = await getDb(ctx.db)
        .select()
        .from(feedback)
        .orderBy(feedback.id);
      const transition = assessmentStateRepo.transitionAssessmentStates;
      const writes = vi
        .spyOn(assessmentStateRepo, "transitionAssessmentStates")
        .mockImplementation(async (...args) => {
          const changed = await transition(...args);
          const owner = currentJobExecution();
          if (owner && failure === "expired" && changed.length)
            vi.setSystemTime(owner.claim.leaseExpiresAt.getTime() + 1);
          return changed;
        });
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        await expect(
          withJobFixtureExecution(
            ctx.db,
            {
              key: "synthetic.no-action-fence",
              kind: "synthetic.no-action",
              input: {},
            },
            async () => {
              const owner = currentJobExecution();
              if (!owner) throw new Error("Expected real Job execution");
              if (failure === "cancelled")
                await cancelJob(ctx.db, owner.claim.id);
              return statementSuggestionsRepo.completeNoActionStatementPrefix(
                ctx.db,
                targets,
              );
            },
          ),
        ).rejects.toThrow("Job generation or lease is obsolete");
        expect(
          await getDb(ctx.db)
            .select()
            .from(assessmentState)
            .where(eq(assessmentState.id, targets[0]!.assessmentId)),
        ).toEqual(before);
        expect(
          await getDb(ctx.db).select().from(feedback).orderBy(feedback.id),
        ).toEqual(beforeEvents);
      } finally {
        vi.useRealTimers();
        writes.mockRestore();
      }
    },
  );

  it("recovers a committed label receipt before its obsolete input fence after retirement failure", async () => {
    const account = (await card(ctx)).output;
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const [before] = await statementSuggestionsRepo.suggestionsNeedingLabels(
      ctx.db,
      10,
    );
    await createRepoIdentity(ctx, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-05",
      merchant: "Example Grocer",
      rawDescription: "SYNTHETIC NEW LEDGER CANDIDATE",
      sourceRefs: [],
    });
    const entries = await completeLabelPublications(ctx);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.proposal.evidenceFingerprint).not.toBe(
      entries[0]!.evidenceFingerprint,
    );
    const afterCommit = databaseHelpers.runAfterCommit;
    let interrupted = false;
    const effect = vi
      .spyOn(databaseHelpers, "runAfterCommit")
      .mockImplementation((db, work) =>
        afterCommit(db, async (committed) => {
          if (!interrupted) {
            interrupted = true;
            throw new Error(
              "Synthetic retirement admission failure after commit",
            );
          }
          return work(committed);
        }),
      );
    const publication = vi.spyOn(assessmentRepo, "publishAssessments");
    try {
      const first =
        await statementSuggestionsRepo.publishCompleteStatementLabels(
          ctx.db,
          entries,
        );
      const key = statementSuggestionsRepo.chargeId(
        entries[0]!.proposal.charge,
      );
      const receipt = first.get(key);
      expect(receipt).toMatchObject({ kind: "ready", origin: "recovered" });
      if (receipt?.kind !== "ready")
        throw new Error("Expected recovered receipt");
      expect(receipt.receipt.applicationOrder).toEqual({
        createdAt: before!.createdAt,
        id: before!.cursorId,
      });
      const [pending] = await statementSuggestionsRepo.suggestionsNeedingLabels(
        ctx.db,
        10,
      );
      expect(pending!.id).toBe(receipt.receipt.assessmentId);
      expect(pending!.checkpoint).toEqual(entries[0]!.checkpoint);
      expect(pending!.applicationPending).toBe(true);
      expect(
        (
          await statementSuggestionsRepo.publishCompleteStatementLabels(
            ctx.db,
            entries,
          )
        ).get(key),
      ).toEqual(receipt);
      expect(publication).toHaveBeenCalledTimes(1);
      expect(
        await label(ctx, async () => {
          throw new Error("Recovered labels must not call the model");
        }),
      ).toMatchObject({
        completed: 1,
        labelled: 0,
        failed: [],
        labels: { generated: 0 },
      });
      expect(
        (
          await statementSuggestionsRepo.publishCompleteStatementLabels(
            ctx.db,
            entries,
          )
        ).get(key),
      ).toEqual({ kind: "resolved", reason: "unchanged" });
      expect(publication).toHaveBeenCalledTimes(1);
    } finally {
      publication.mockRestore();
      effect.mockRestore();
    }
  });

  it("repairs committed application receipts on resume when retirement never succeeded", async () => {
    await card(ctx);
    await record(ctx, [
      rowInput(),
      rowInput({
        rawDescription: "SYNTHETIC SECOND RECEIPT",
        providerAmount: -12,
      }),
    ]);
    await generate(ctx);
    const entries = await completeLabelPublications(ctx);
    const afterCommit = databaseHelpers.runAfterCommit;
    const effect = vi
      .spyOn(databaseHelpers, "runAfterCommit")
      .mockImplementation((db) =>
        afterCommit(db, async () => {
          throw new Error("Synthetic unavailable retirement connection");
        }),
      );
    const publication = vi.spyOn(assessmentRepo, "publishAssessments");
    try {
      const first =
        await statementSuggestionsRepo.publishCompleteStatementLabels(
          ctx.db,
          entries,
        );
      expect([...first.values()].map((result) => result.kind)).toEqual([
        "failed",
        "failed",
      ]);
      const pending = await statementSuggestionsRepo.suggestionsNeedingLabels(
        ctx.db,
        10,
      );
      expect(pending).toHaveLength(2);
      expect(pending.every((row) => row.applicationPending)).toBe(true);
      expect(pending.map((row) => row.checkpoint)).toEqual(
        entries.map((entry) => entry.checkpoint),
      );
      effect.mockRestore();
      const repair = vi.spyOn(
        statementSuggestionsRepo,
        "repairStatementApplicationReceipts",
      );
      try {
        expect(
          await label(ctx, async () => {
            throw new Error(
              "Durable model answers must survive failed retirement",
            );
          }),
        ).toMatchObject({
          completed: 2,
          labelled: 0,
          failed: [],
          labels: { generated: 0 },
        });
        expect(repair).toHaveBeenCalledWith(
          ctx.db,
          pending.map((row, index) => ({
            assessmentId: row.id,
            charge: entries[index]!.proposal.charge,
          })),
        );
        expect(publication).toHaveBeenCalledTimes(1);
        expect(
          await statementSuggestionsRepo.suggestionsNeedingLabels(ctx.db, 10),
        ).toEqual([]);
      } finally {
        repair.mockRestore();
      }
    } finally {
      publication.mockRestore();
      effect.mockRestore();
    }
  });

  it.each(["cancelled", "expired"] as const)(
    "rolls back complete label batches under %s Job ownership",
    async (failure) => {
      await card(ctx);
      await record(ctx, [
        rowInput(),
        rowInput({
          rawDescription: "SYNTHETIC FENCED PEER",
          providerAmount: -12,
        }),
      ]);
      await generate(ctx);
      const before = await statementSuggestionsRepo.suggestionsNeedingLabels(
        ctx.db,
        10,
      );
      const entries = await completeLabelPublications(ctx);
      const publish = assessmentRepo.publishAssessments;
      const publication = vi
        .spyOn(assessmentRepo, "publishAssessments")
        .mockImplementation(async (...args) => {
          const result = await publish(...args);
          const owner = currentJobExecution();
          if (!owner) throw new Error("Expected real Job execution");
          vi.setSystemTime(owner.claim.leaseExpiresAt.getTime() + 1);
          return result;
        });
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        await expect(
          withJobFixtureExecution(
            ctx.db,
            {
              key: "synthetic.label-batch-fence",
              kind: "synthetic.label-batch",
              input: {},
            },
            async () => {
              const owner = currentJobExecution();
              if (!owner) throw new Error("Expected real Job execution");
              if (failure === "cancelled")
                await cancelJob(ctx.db, owner.claim.id);
              return statementSuggestionsRepo.publishCompleteStatementLabels(
                ctx.db,
                entries,
              );
            },
          ),
        ).rejects.toThrow("Job generation or lease is obsolete");
        expect(
          await statementSuggestionsRepo.suggestionsNeedingLabels(ctx.db, 10),
        ).toEqual(before);
        expect(publication).toHaveBeenCalledTimes(
          failure === "cancelled" ? 0 : 1,
        );
      } finally {
        vi.useRealTimers();
        publication.mockRestore();
      }
    },
  );

  // Publication failure must not discard a completely paid judgment before retry.
  it("resumes automatic application after a crash following model publication", async () => {
    await card(ctx);
    await record(ctx, [
      rowInput(),
      rowInput({
        rawDescription: "EXAMPLE GROCER SECOND",
        providerAmount: -12,
      }),
    ]);
    await generate(ctx);
    const before = await statementSuggestionsRepo.suggestionsNeedingLabels(
      ctx.db,
      10,
    );
    const charges = (await suggestions(ctx)).map(({ source, chargeKey }) => ({
      source,
      chargeKey,
    }));
    const proposals = await buildChargeProposals(ctx.db, charges);
    // Publication can settle in reverse order; recovery must retain the input order.
    for (const row of [...before].reverse()) {
      const proposal = proposals.find(
        (entry) => entry.evidenceFingerprint === row.evidenceFingerprint,
      )!;
      const judgment = structuredClone(proposal!.judgment);
      judgment.create!.votes.label = "purchase";
      judgment.create!.counterparty.label = "business";
      // Stop at the durable boundary that precedes automatic application.
      await publishChargeProposal(
        ctx.db,
        await labelledProposal(proposal!, judgment),
        {
          kind: "model",
          model: DECISION_MODEL,
          revision: STATEMENT_LABEL_REVISION,
          runId: null,
          evaluationId: null,
        },
      );
    }
    const receipts = await statementSuggestionsRepo.suggestionsNeedingLabels(
      ctx.db,
      10,
    );
    expect(receipts.map((row) => row.subject)).toEqual(
      before.map((row) => row.subject),
    );
    expect(
      await statementSuggestionsRepo.countSuggestionsNeedingLabels(ctx.db),
    ).toBe(2);
    const resumed = await label(ctx, async () => {
      throw new Error(
        "Published labels must not be recomputed during application recovery",
      );
    });
    expect(resumed.failed).toEqual([]);
    expect(resumed.completed).toBe(2);
    expect(resumed.labelled).toBe(0);
    expect(resumed.labels.generated).toBe(0);
    expect(
      await statementSuggestionsRepo.countSuggestionsNeedingLabels(ctx.db),
    ).toBe(0);
  });

  it("skips superseded evidence and publishes fresh labels for the revised charge", async () => {
    await card(ctx);
    const original = rowInput({
      providerTransactionId: "synthetic-revised-charge",
      merchant: "Synthetic generated evidence",
    });
    await record(ctx, [original]);
    await generate(ctx);
    const [before] = await suggestions(ctx);
    await record(
      ctx,
      [
        {
          ...original,
          providerAmount: -48,
          merchant: "Synthetic changed evidence",
        },
      ],
      { fingerprint: "synthetic-speculation-mutation" },
    );
    expect(await suggestions(ctx)).toEqual([]);
    expect(
      await statementSuggestionsRepo.suggestionsNeedingLabels(ctx.db, 1),
    ).toEqual([]);
    expect(
      (await listSourceTransactionRecords(ctx.db, {})).data.map(
        ({ current, amount }) => ({
          current,
          amount,
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        { current: false, amount: 42.5 },
        { current: true, amount: 48 },
      ]),
    );
    const stale = await label(ctx, async () => {
      throw new Error("Fresh evidence must be regenerated before publication");
    });
    expect(stale).toMatchObject({
      labelled: 0,
      completed: 0,
      stale: 0,
      failed: [],
      labels: { generated: 0 },
    });
    expect(await suggestions(ctx)).toEqual([]);
    await generate(ctx);
    const answer = answering({ kind: "purchase", counterparty: "business" });
    let freshQuestions = 0;
    const published = await label(ctx, async (request) => {
      freshQuestions++;
      expect(request.state).toContain("Synthetic changed evidence");
      return answer(request);
    });
    expect(published).toMatchObject({
      labelled: 1,
      completed: 1,
      failed: [],
      labels: { generated: 3, reused: 0 },
    });
    expect(freshQuestions).toBe(2);
    const [fresh] = await suggestions(ctx);
    expect(fresh).toMatchObject({
      chargeKey: before!.chargeKey,
      amount: 48,
      create: { merchant: "Synthetic changed evidence", amount: 48 },
    });
    expect(fresh!.fingerprint).not.toBe(before!.fingerprint);
  });

  it.each([
    { failure: "model", resolution: "retry" },
    { failure: "publication", resolution: "retry" },
    { failure: "model", resolution: "exhausted" },
    { failure: "publication", resolution: "exhausted" },
  ])(
    "keeps competing automatic applications ordered across $failure failure and $resolution",
    async ({ failure, resolution }) => {
      await enableStatementAttach(ctx);
      const account = (await card(ctx)).output;
      await createRepoIdentity(ctx, "financialTransaction", {
        accountId: account.id,
        kind: "purchase",
        status: "posted",
        amount: 42.5,
        postedDate: "2026-05-05",
        merchant: "Older import label",
        rawDescription: "EXMPL GRCR #1 SYNTHETIC",
        sourceRefs: [],
      });
      await record(ctx, [
        rowInput({
          rawDescription: "EXAMPLE GROCER 0001",
          statementDate: "2026-05-04",
          rowPosition: 1,
        }),
      ]);
      await generate(ctx);
      await record(ctx, [
        rowInput({
          rawDescription: "EXAMPLE GROCER 0002",
          statementDate: "2026-05-06",
          rowPosition: 2,
        }),
      ]);
      await generate(ctx);
      const originalOrder =
        await statementSuggestionsRepo.suggestionsNeedingLabels(ctx.db, 10);
      expect(originalOrder).toHaveLength(2);
      const [earlier] = await suggestions(ctx).then((rows) =>
        rows.filter((row) => row.rawDescription === "EXAMPLE GROCER 0001"),
      );
      let failing = true;
      let laterCalls = 0;
      const answer = answering({ kind: "purchase", counterparty: "business" });
      const port: DecisionPort = async (request) => {
        if (request.state.includes("EXAMPLE GROCER 0002")) laterCalls++;
        if (
          failure === "model" &&
          failing &&
          request.state.includes("EXAMPLE GROCER 0001")
        )
          throw new Error("Synthetic earlier model failure");
        return answer(request);
      };
      let removeFailure =
        failure === "publication"
          ? await rejectStatementPublication(ctx, earlier!.chargeKey, "model")
          : undefined;
      try {
        const first = await label(ctx, port);
        expect(first).toMatchObject({ labelled: 1, completed: 0 });
        expect(first.failed).toHaveLength(1);
        // The failure stays in the original-input retry budget. Only the later
        // durable receipt advances after that budget is exhausted.
        expect(first.next).toEqual({
          createdAt: originalOrder[1]!.createdAt,
          id: originalOrder[1]!.cursorId,
          inclusive: true,
        });
        expect(
          (await listSourceTransactionRecords(ctx.db, {})).data.every(
            (row) => row.matchState === "unmatched",
          ),
        ).toBe(true);
        const pending = await statementSuggestionsRepo.suggestionsNeedingLabels(
          ctx.db,
          10,
        );
        expect(pending).toHaveLength(2);
        expect(pending[1]!.applicationPending).toBe(true);
        const retainedLaterCalls = laterCalls;
        failing = resolution === "exhausted";
        if (removeFailure && !failing) {
          await removeFailure();
          removeFailure = undefined;
        }
        const resumed = await labelStatementSuggestions(ctx.db, {
          port,
          runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
          ...(resolution === "exhausted" && { after: first.next }),
        });
        expect(resumed.failed).toEqual([]);
        expect(resumed.next).toBeNull();
        expect(laterCalls).toBe(retainedLaterCalls);
        const rows = (await listSourceTransactionRecords(ctx.db, {})).data;
        const winner =
          resolution === "retry"
            ? "EXAMPLE GROCER 0001"
            : "EXAMPLE GROCER 0002";
        const loser =
          resolution === "retry"
            ? "EXAMPLE GROCER 0002"
            : "EXAMPLE GROCER 0001";
        expect(
          rows.find((row) => row.rawDescription === winner)?.matchState,
        ).toBe("matched");
        expect(
          rows.find((row) => row.rawDescription === loser)?.matchState,
        ).toBe("unmatched");
      } finally {
        await removeFailure?.();
      }
    },
  );

  // The allowance must bound prompt preparation too, while keeping the exact
  // candidate roster and the earliest untouched charge available to replay.
  it("bounds saturated label preparation and replays the untouched suffix", async () => {
    const account = (await card(ctx)).output;
    await createRepoIdentity(ctx, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-05",
      rawDescription: "SYNTHETIC BOUNDED CANDIDATE",
      sourceRefs: [],
    });
    await record(ctx, [
      rowInput({
        providerTransactionId: "synthetic-bounded-first",
        rawDescription: "SYNTHETIC BOUNDED FIRST",
      }),
      rowInput({
        providerTransactionId: "synthetic-bounded-suffix",
        rawDescription: "SYNTHETIC BOUNDED SUFFIX",
      }),
    ]);
    await generate(ctx);
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "background" });
    const before = await statementSuggestionsRepo.suggestionsNeedingLabels(
      ctx.db,
      2,
    );
    const seen: string[] = [];
    const answer = answering({ kind: "purchase", counterparty: "business" });
    const port: DecisionPort = async (request) => {
      seen.push(JSON.stringify(request));
      return answer(request);
    };
    const fits = vi.spyOn(decisionModel, "decisionChoiceFitsContext");
    try {
      const first = await labelStatementSuggestions(ctx.db, {
        runId,
        port,
        decisionLimit: 1,
      });
      expect(first).toMatchObject({
        completed: 0,
        failed: [],
        labels: { generated: 1 },
      });
      expect(fits).toHaveBeenCalledTimes(1);
      expect(first.next).toMatchObject({
        id: before[0]!.cursorId,
        inclusive: true,
      });
      const partial = await statementSuggestionsRepo.suggestionsNeedingLabels(
        ctx.db,
        2,
      );
      expect(partial[0]!.checkpoint!.judgment.candidates).toMatchObject([
        { label: { same: "same", confidence: "high" } },
      ]);
      expect(partial[1]!.checkpoint).toBeNull();
      expect(partial[1]!.judgment).toEqual(before[1]!.judgment);
      fits.mockClear();
      const second = await labelStatementSuggestions(ctx.db, {
        runId,
        port,
        after: first.next,
        decisionLimit: 3,
      });
      expect(second).toMatchObject({
        completed: 1,
        labelled: 1,
        failed: [],
        labels: { generated: 3, reused: 1 },
      });
      expect(fits).toHaveBeenCalledTimes(2);
      expect(second.next).toMatchObject({
        id: before[1]!.cursorId,
        inclusive: true,
      });
      const suffix = await statementSuggestionsRepo.suggestionsNeedingLabels(
        ctx.db,
        2,
      );
      expect(suffix).toHaveLength(1);
      expect(suffix[0]!.checkpoint).toBeNull();
      expect(suffix[0]!.judgment.candidates).toHaveLength(1);
      const last = await labelStatementSuggestions(ctx.db, {
        runId,
        port,
        after: second.next,
        decisionLimit: 4,
      });
      expect(last).toMatchObject({ completed: 1, failed: [], next: null });
      expect(seen).toHaveLength(6);
      expect(new Set(seen).size).toBe(6);
      expect(
        await labelStatementSuggestions(ctx.db, { runId, port }),
      ).toMatchObject({
        completed: 0,
        labelled: 0,
        failed: [],
        next: null,
      });
      expect(seen).toHaveLength(6);
    } finally {
      fits.mockRestore();
    }
  });

  it("reuses checkpoint-only labels after admission is exhausted", async () => {
    await card(ctx);
    await record(ctx, [
      rowInput({ providerTransactionId: "synthetic-admission-first" }),
      rowInput({ providerTransactionId: "synthetic-checkpoint-only" }),
    ]);
    await generate(ctx);
    const before = await statementSuggestionsRepo.suggestionsNeedingLabels(
      ctx.db,
      2,
    );
    const saved = before[1]!;
    const charge = assessmentSubjects.statement_transaction.parse(
      saved.subject,
    );
    const [proposal] = await buildChargeProposals(ctx.db, [charge]);
    const judgment = structuredClone(proposal!.judgment);
    judgment.create!.votes.label = "other";
    judgment.create!.counterparty.label = "business";
    await statementSuggestionsRepo.recordStatementLabelCheckpoint(ctx.db, {
      charge,
      evidenceFingerprint: saved.evidenceFingerprint,
      checkpoint: {
        revision: STATEMENT_LABEL_REVISION,
        model: null,
        models: [],
        judgment,
        kind: true,
        counterparty: true,
        spending: true,
      },
    });
    const outcome = await labelStatementSuggestions(ctx.db, {
      runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
      port: answering({ kind: "other", counterparty: "business" }),
      decisionLimit: 1,
    });
    expect(outcome).toMatchObject({
      labelled: 1,
      completed: 0,
      failed: [],
      labels: { reused: 3 },
    });
    expect(outcome.next).toMatchObject({
      id: before[0]!.cursorId,
      inclusive: true,
    });
    const resumed = await labelStatementSuggestions(ctx.db, {
      runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
      port: answering({ kind: "other", counterparty: "business" }),
      after: outcome.next,
    });
    expect(resumed).toMatchObject({ completed: 2, failed: [], next: null });
  });

  it("keeps context-overflow defaults free before the last admitted question", async () => {
    await card(ctx);
    await record(ctx, [
      rowInput({
        providerTransactionId: "synthetic-overflow-charge",
        rawDescription: "synthetic oversized evidence ".repeat(40_000),
      }),
    ]);
    await generate(ctx);
    await record(
      ctx,
      [rowInput({ providerTransactionId: "synthetic-fitting-charge" })],
      {
        fingerprint: "synthetic-fitting-import",
      },
    );
    await generate(ctx);
    const before = await statementSuggestionsRepo.suggestionsNeedingLabels(
      ctx.db,
      2,
    );
    const overflowing = before.find(
      (row) => (row.judgment.create?.rawDescription?.length ?? 0) > 32_000,
    );
    expect(overflowing).toBeDefined();
    if (!overflowing) return;
    await statementSuggestionsRepo.recordStatementLabelCheckpoint(ctx.db, {
      charge: assessmentSubjects.statement_transaction.parse(
        overflowing.subject,
      ),
      evidenceFingerprint: overflowing.evidenceFingerprint,
      checkpoint: {
        revision: STATEMENT_LABEL_REVISION,
        model: null,
        models: [],
        judgment: overflowing.judgment,
        kind: false,
        counterparty: false,
        spending: true,
      },
    });
    // Freeze historical cursor order so the real overflow precedes fitting work.
    await getDb(ctx.db)
      .update(assessmentState)
      .set({ createdAt: new Date("2026-01-01T00:00:00Z") })
      .where(eq(assessmentState.id, overflowing.id));
    const fits = vi.spyOn(decisionModel, "decisionChoiceFitsContext");
    const port = vi.fn(answering({ kind: "other", counterparty: "business" }));
    try {
      const outcome = await labelStatementSuggestions(ctx.db, {
        runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
        port,
        decisionLimit: 1,
      });
      expect(fits.mock.results.some((result) => result.value === false)).toBe(
        true,
      );
      expect(port).toHaveBeenCalledTimes(1);
      expect(outcome.failed).toEqual([]);
      expect(outcome.labels).toMatchObject({ generated: 3, reused: 1 });
      const saved = await statementSuggestionsRepo.suggestionsNeedingLabels(
        ctx.db,
        2,
      );
      expect(saved.map((row) => row.checkpoint)).toMatchObject([
        { kind: true, counterparty: false },
      ]);
    } finally {
      fits.mockRestore();
    }
  });

  it("does not persist empty checkpoints when no label questions are admitted", async () => {
    await card(ctx);
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "background" });
    const port: DecisionPort = async () => {
      throw new Error("A zero-question budget must not admit model work");
    };
    const fits = vi.spyOn(decisionModel, "decisionChoiceFitsContext");
    let normal: Awaited<ReturnType<typeof labelStatementSuggestions>>;
    try {
      normal = await labelStatementSuggestions(ctx.db, {
        runId,
        port,
        decisionLimit: 0,
      });
      expect(fits).not.toHaveBeenCalled();
    } finally {
      fits.mockRestore();
    }
    expect(normal).toMatchObject({
      labelled: 0,
      completed: 0,
      failed: [],
      labels: { generated: 0 },
    });
    expect(normal.next).toMatchObject({ inclusive: true });
    expect(
      (await statementSuggestionsRepo.suggestionsNeedingLabels(ctx.db, 1))[0]!
        .checkpoint,
    ).toBeNull();
    expect(
      await label(
        ctx,
        answering({ kind: "purchase", counterparty: "business" }),
      ),
    ).toMatchObject({
      labelled: 1,
      completed: 1,
      failed: [],
      labels: { generated: 3 },
    });
  });

  it("rejects model publication when generation replaces its evidence during computation", async () => {
    await card(ctx);
    const original = rowInput({
      providerTransactionId: "synthetic-mid-label-record",
    });
    await record(ctx, [original]);
    await generate(ctx);
    let moved = false;
    const answer = answering({ kind: "purchase", counterparty: "business" });
    const outcome = await label(ctx, async (request) => {
      if (!moved) {
        moved = true;
        await record(
          ctx,
          [{ ...original, providerNotes: "Synthetic replacement evidence" }],
          { fingerprint: "synthetic-mid-label-replacement" },
        );
        await generate(ctx);
      }
      return answer(request);
    });
    expect(outcome).toMatchObject({ labelled: 0, completed: 0 });
    expect(outcome.failed).toHaveLength(1);
    expect((await suggestions(ctx))[0]!.create!.votes.label).toBeNull();
    expect(await label(ctx, answer)).toMatchObject({ labelled: 1, failed: [] });
  });

  it("retains completed decisions when model publication fails", async () => {
    await card(ctx);
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const answer = answering({ kind: "purchase", counterparty: "business" });
    let calls = 0;
    const port: DecisionPort = async (input) => {
      calls++;
      return answer(input);
    };
    const [pending] = await suggestions(ctx);
    let removeFailure: (() => Promise<void>) | undefined =
      await rejectStatementPublication(ctx, pending!.chargeKey, "model");
    try {
      const first = await label(ctx, port);
      expect(first.failed).toHaveLength(1);
      expect(first.labels).toEqual({ reused: 0, generated: 3 });
      const [retained] =
        await statementSuggestionsRepo.suggestionsNeedingLabels(ctx.db, 1);
      expect(retained!.checkpoint).toMatchObject({
        kind: true,
        counterparty: true,
        judgment: {
          create: {
            votes: { label: "purchase" },
            counterparty: { label: "business" },
          },
        },
      });
      await removeFailure();
      removeFailure = undefined;
      const resumed = await label(ctx, port);
      expect(resumed.labelled).toBe(1);
      expect(resumed.labels).toEqual({ reused: 3, generated: 0 });
      expect(calls).toBe(2);
    } finally {
      await removeFailure?.();
    }
  });

  // A pause after generation must preserve earlier paid labels while new
  // charges remain unlabelled; retrying asks only for those unfinished charges.
  it("keeps existing labels when a re-Sweep is interrupted mid-label", async () => {
    await card(ctx);
    const original = rowInput({
      providerTransactionId: "synthetic-interrupted-record",
    });
    await record(ctx, [original]);
    await generate(ctx);
    await label(ctx, answering({ kind: "purchase", counterparty: "business" }));
    const [before] = await suggestions(ctx);
    await record(
      ctx,
      [
        { ...original, rowPosition: 10, providerNotes: "Synthetic new memo" },
        rowInput({
          rawDescription: "EXAMPLE NEW CHARGE",
          merchant: "Example Cafe",
          providerAmount: -12,
        }),
      ],
      { fingerprint: "synthetic-interrupted-export" },
    );
    await generate(ctx);
    const paused = new AiBudgetExhaustedError(
      {
        windowStart: "2026-05-04T00:00:00Z",
        windowEnd: "2026-05-04T06:00:00Z",
        credit: { limitUsd: 1, spentUsd: 0 },
        plan: { limitUsd: 1, spentUsd: 0 },
        paid: { limitUsd: 1, spentUsd: 1 },
      },
      "Synthetic interruption",
    );
    await expect(
      label(ctx, async () => {
        throw paused;
      }),
    ).rejects.toBe(paused);
    const retained = (await suggestions(ctx)).find(
      (row) => row.chargeKey === before!.chargeKey,
    );
    expect(retained).toMatchObject({
      clean: true,
      create: {
        votes: { label: "purchase" },
        counterparty: { label: "business" },
      },
    });
    const seen: string[] = [];
    const answer = answering({ kind: "purchase", counterparty: "business" });
    await label(ctx, async (input) => {
      seen.push(input.state);
      return answer(input);
    });
    expect(
      seen.every((subject) => subject.includes("EXAMPLE NEW CHARGE")),
    ).toBe(true);
    expect((await suggestions(ctx)).every((row) => row.clean)).toBe(true);
  });

  // Failure mode: the model picks `interest` for interest earned, which the
  // settlement sign rule refuses, so the accept could never apply.
  it("ignores a model kind the transaction could not be created as", async () => {
    await card(ctx);
    await record(ctx, [
      rowInput({
        providerAmount: 8.66,
        merchant: "Example Bank",
        rawDescription: "EXAMPLE INTEREST PAID",
        sourceCategory: null,
      }),
    ]);
    await generate(ctx);
    await label(ctx, answering({ kind: "interest", counterparty: "business" }));
    const [suggestion] = await suggestions(ctx);
    expect(suggestion!.create).toMatchObject({
      amount: -8.66,
      kind: "refund",
      kindSource: "sign",
      votes: { label: "interest" },
    });
    expect(suggestion!.clean).toBe(false);
  });

  // Failure mode: every recorded chunk regenerates the whole ledger.
  it("limits an import's pass to the charges it observed", async () => {
    await card(ctx);
    await record(ctx, [rowInput({ rawDescription: "EXAMPLE OLDER CHARGE" })]);
    const later = await record(
      ctx,
      [rowInput({ rawDescription: "EXAMPLE NEWER CHARGE" })],
      { fingerprint: "fp-later-import" },
    );
    const page = await generateStatementSuggestionPage(ctx.db, {
      after: null,
      runId: null,
      scope: { importId: later.batchId },
    });
    expect(page).toMatchObject({ published: 1, next: null });
    expect((await suggestions(ctx)).map((row) => row.rawDescription)).toEqual([
      "EXAMPLE NEWER CHARGE",
    ]);
  });

  it("pages labels across original and receipt positions within exact import scope", async () => {
    await card(ctx);
    const description = (index: number) => `SYNTHETIC LABEL POSITION ${index}`;
    const first = await record(
      ctx,
      Array.from({ length: 8 }, (_, index) =>
        rowInput({
          rawDescription: description(index),
          providerAmount: -10 - index,
        }),
      ),
    );
    await record(
      ctx,
      [rowInput({ rawDescription: description(8), providerAmount: -18 })],
      { fingerprint: "synthetic-label-outside" },
    );
    await generate(ctx);
    const rows = await statementSuggestionsRepo.suggestionsNeedingLabels(
      ctx.db,
      20,
    );
    const byDescription = new Map(
      rows.map((row) => [row.judgment.create?.rawDescription, row]),
    );
    const target = (index: number) => {
      const found = byDescription.get(description(index));
      if (!found) throw new Error("Synthetic label target missing");
      return found;
    };
    const nativeSeconds = [2, 6, 7, 2, 8, 4, 0, 0.5, 0.25];
    const overrides = new Map<number, Record<string, string>>([
      [
        1,
        {
          createdAt: "2026-01-01T00:00:01.000001",
          id: "00000000-0000-0000-0000-000000000001",
        },
      ],
      [
        2,
        {
          createdAt: "2026-01-01T00:00:01.000000",
          id: "00000000-0000-0000-0000-000000000003",
        },
      ],
      [3, { id: "00000000-0000-0000-0000-000000000000" }],
      [4, { createdAt: "2026-01-01T00:00:03.000000" }],
    ]);
    for (const [index, seconds] of nativeSeconds.entries()) {
      const extra = {
        ...(overrides.has(index) && { applicationOrder: overrides.get(index) }),
        ...(index === 1 && { needsLabel: false, applicationPending: true }),
        ...(index === 7 && { reviewReason: "Synthetic withdrawn review" }),
      };
      await getDb(ctx.db)
        .update(assessmentState)
        .set({
          createdAt: new Date(Date.UTC(2026, 0, 1) + seconds * 1000),
          data: sql`${assessmentState.data} || ${JSON.stringify(extra)}::jsonb`,
        })
        .where(eq(assessmentState.id, target(index).id));
    }
    // A withdrawn head is absent unless its retained correction review allows it.
    for (const index of [6, 7])
      await getDb(ctx.db)
        .update(sourceTransactionRecord)
        .set({ withdrawnAt: new Date() })
        .where(
          sql`${sourceTransactionRecord.source}='monarch' AND ${sourceTransactionRecord.externalId}=(SELECT data->>'headRef' FROM "AssessmentState" WHERE id=${target(index).id}::uuid)`,
        );
    const durableRun = await ensureRun(ctx.db, ctx.actor, {
      purpose: "sweep",
      trigger: "manual",
      status: "running",
    });
    await ensureRunSteps(ctx.db, durableRun, [
      { key: "statement_label", label: "Decision labels" },
    ]);
    await getDb(ctx.db)
      .update(runStep)
      .set({
        state: "running",
        found: 9,
        done: 3,
        pages: 1,
        cursor: { createdAt: "2026-01-01T00:00:01.000001", id: target(1).id },
      })
      .where(eq(runStep.runId, durableRun));
    await setAutomaticRule(ctx.db, ctx.actor, {
      ruleKey: "statement_transaction.attach",
      enabled: false,
    });
    // Reproduce the populated predecessor, then apply the exact migration.
    // Index construction must preserve evidence, history, controls and durable work.
    await databaseHelpers.withTransactionDatabase(ctx.db, async (tx) => {
      await getDb(tx).execute(
        sql`DROP INDEX "AssessmentState_statement_label_native_idx"`,
      );
      await getDb(tx).execute(
        sql`DROP INDEX "AssessmentState_statement_label_receipt_idx"`,
      );
      const retained = async () => {
        const snapshots: unknown[] = [];
        for (const table of [
          sourceTransactionRecord,
          transactionImport,
          transactionImportRecord,
          assessment,
          assessmentState,
          feedback,
          financialTransaction,
          financialTransactionAllocation,
          purchase,
          expense,
          run,
          runStep,
          job,
          automaticRule,
          appSettings,
        ]) {
          const { rows } = await getDb(tx).execute<{ records: unknown }>(
            sql`SELECT coalesce(jsonb_agg(to_jsonb(retained) ORDER BY to_jsonb(retained)::text),'[]'::jsonb) AS records FROM ${table} retained`,
          );
          snapshots.push(rows[0]?.records);
        }
        return snapshots;
      };
      const before = await retained();
      for (const statement of readFileSync(
        new URL(
          "../../../../../drizzle/0015_statement_label_cursor_work.sql",
          import.meta.url,
        ),
        "utf8",
      ).split("--> statement-breakpoint"))
        await getDb(tx).execute(sql.raw(statement));
      expect(await retained()).toEqual(before);
    });
    const expected = [8, 7, 2, 1, 3, 0, 4, 5].map((index) => target(index).id);
    const actual: string[] = [];
    let after: Parameters<
      typeof statementSuggestionsRepo.suggestionsNeedingLabels
    >[2] = null;
    for (;;) {
      const page = await statementSuggestionsRepo.suggestionsNeedingLabels(
        ctx.db,
        2,
        after,
      );
      actual.push(...page.map((row) => row.id));
      const last = page.at(-1);
      if (!last) break;
      after = { createdAt: last.createdAt, id: last.cursorId };
    }
    expect(actual).toEqual(expected);
    const scoped = await statementSuggestionsRepo.suggestionsNeedingLabels(
      ctx.db,
      20,
      null,
      { importId: first.batchId },
    );
    expect(scoped.map((row) => row.id)).toEqual(expected.slice(1));
    expect(
      await statementSuggestionsRepo.countSuggestionsNeedingLabels(ctx.db),
    ).toBe(expected.length);
    expect(
      await statementSuggestionsRepo.countSuggestionsNeedingLabels(ctx.db, {
        importId: first.batchId,
      }),
    ).toBe(expected.length - 1);
    const boundary = scoped[1];
    if (!boundary) throw new Error("Synthetic microsecond boundary missing");
    expect(boundary.createdAt).toBe("2026-01-01T00:00:01.000000");
    expect(
      (
        await statementSuggestionsRepo.suggestionsNeedingLabels(
          ctx.db,
          2,
          {
            createdAt: boundary.createdAt,
            id: boundary.cursorId,
            inclusive: true,
          },
          { importId: first.batchId },
        )
      ).map((row) => row.id),
    ).toEqual([target(2).id, target(1).id]);
    expect(
      (
        await statementSuggestionsRepo.suggestionsNeedingLabels(
          ctx.db,
          2,
          { createdAt: boundary.createdAt, id: boundary.cursorId },
          { importId: first.batchId },
        )
      ).map((row) => row.id),
    ).toEqual([target(1).id, target(3).id]);
  });

  it.each(["unresolved", "conflicting"])(
    "discovers matched booking with %s source account evidence",
    async (sourceResolution) => {
      const account = (await card(ctx)).output;
      const conflictingAccount =
        sourceResolution === "conflicting"
          ? (
              await createRepoIdentity(ctx, "financialAccount", {
                name: "Synthetic competing source account",
                identity: {
                  kind: "credit_card",

                  network: "visa",
                },
                sourceAliases: [
                  {
                    source: "monarch",
                    alias: "Synthetic historical account label",
                    externalAccountId: null,
                  },
                ],
              })
            ).output
          : null;
      await record(ctx, [
        rowInput({ accountDescriptor: "Synthetic historical account label" }),
      ]);
      const [source] = (await listSourceTransactionRecords(ctx.db, {})).data;
      if (!source) throw new Error("Synthetic retained source missing");
      const transaction = await createRepoIdentity(
        ctx,
        "financialTransaction",
        {
          accountId: account.id,
          kind: "purchase",
          status: "posted",
          amount: 42.5,
          postedDate: "2026-05-04",
          merchant: "Example Grocer",
          sourceRefs: [{ source: "monarch", externalId: source.externalId }],
        },
      );
      const before = await getDb(ctx.db).select().from(sourceTransactionRecord);
      await generate(ctx);
      expect(await suggestions(ctx)).toMatchObject([
        {
          recommended: "book",
          accountId: conflictingAccount?.id ?? account.id,
          matchedTransactionId: transaction.output.id,
          ...(conflictingAccount
            ? {
                clean: false,
                reviewReason:
                  "The source account conflicts with the accepted transaction account; review the account evidence.",
              }
            : {}),
        },
      ]);
      expect(
        await getDb(ctx.db).select().from(sourceTransactionRecord),
      ).toEqual(before);
      expect(
        await getDb(ctx.db).select().from(financialTransaction),
      ).toHaveLength(1);
      expect(await getDb(ctx.db).select().from(expense)).toHaveLength(0);
    },
  );

  // Failure modes: a ref attached on another path (the import page, an
  // agent's entity.update) leaves the suggestion live, and accepting it
  // records the charge twice.
  it("hides and refuses stale evidence when its charge is attached elsewhere", async () => {
    const account = (await card(ctx)).output;
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const [suggestion] = await suggestions(ctx);
    const [row] = (await listSourceTransactionRecords(ctx.db, {})).data;
    await createRepoIdentity(ctx, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-04",
      merchant: "Example Grocer",
      rawDescription: "EXAMPLE GROCER 0001",
      sourceRefs: [{ source: "monarch", externalId: row!.externalId }],
    });
    expect(await stateOf(ctx, suggestion!.assessmentId)).toMatchObject({
      status: "pending",
      active: true,
    });
    expect(await suggestions(ctx)).toEqual([]);
    await expect(accept(ctx, suggestion!)).rejects.toThrow(
      /evidence changed|stale/,
    );
    // Republication, not a scanner, replaces the stale advice.
    expect(await generate(ctx)).toBe(1);
    expect(await stateOf(ctx, suggestion!.assessmentId)).toMatchObject({
      status: "superseded",
      active: false,
    });
    expect((await suggestions(ctx))[0]).toMatchObject({
      recommended: "book",
      clean: false,
    });
  });

  // Failure mode: two members (or an agent and a member) accepting the same
  // suggestion at once create two transactions for one charge.
  it("applies concurrent accepts of one suggestion once", async () => {
    await card(ctx);
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const [suggestion] = await suggestions(ctx);
    const outcomes = await Promise.allSettled([
      accept(ctx, suggestion!),
      accept(ctx, suggestion!),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const created = await getDb(ctx.db).execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM "FinancialTransaction" WHERE "deletedAt" IS NULL`,
    );
    expect(created.rows[0]?.count).toBe(1);
  });

  // Failure mode: accepting one of two firmed-up twins leaves the other's
  // suggestion stale until a whole-ledger refresh.
  it("refreshes a sibling's suggestion after its twin is applied", async () => {
    await card(ctx);
    await record(ctx, [rowInput({ rawDescription: "EXAMPLE MKTPLACE PMTS" })]);
    await record(
      ctx,
      [rowInput({ rawDescription: "EXAMPLE MKTPL*AB12CD34" })],
      { fingerprint: "fp-firmed" },
    );
    await generate(ctx);
    const [first] = await suggestions(ctx);
    await accept(ctx, first!);
    const [twin] = await suggestions(ctx);
    expect(twin).toMatchObject({
      recommended: "attach",
      siblings: 0,
      candidates: [
        expect.objectContaining({
          transactionId: expect.stringMatching(/^FTX-/),
        }),
      ],
    });
    expect(twin!.rawDescription).not.toBe(first!.rawDescription);
  });

  // Failure mode: once one of two same-amount charges is attached, the other
  // has no unmatched sibling left, so a model "same" alone would bulk-attach a
  // second real charge onto the transaction that already settles the first.
  it("never cleans an attach to a transaction another charge already settles", async () => {
    await card(ctx);
    await record(ctx, [rowInput({ rawDescription: "EXAMPLE CAFE 0001" })]);
    await record(
      ctx,
      [
        rowInput({
          rawDescription: "EXAMPLE CAFE 0002",
          statementDate: "2026-05-05",
        }),
      ],
      { fingerprint: "fp-second-visit" },
    );
    await generate(ctx);
    const older = (await suggestions(ctx)).find(
      (row) => row.rawDescription === "EXAMPLE CAFE 0001",
    );
    await accept(ctx, older!);
    await label(ctx, answering({ kind: "purchase", counterparty: "business" }));
    const [second] = await suggestions(ctx);
    expect(second).toMatchObject({
      rawDescription: "EXAMPLE CAFE 0002",
      recommended: "attach",
      siblings: 0,
      clean: false,
      candidates: [
        expect.objectContaining({
          claimed: true,
          label: expect.objectContaining({ same: "same", confidence: "high" }),
        }),
      ],
    });
  });

  // Failure mode: a charge the member set aside (ignored, or superseded by the
  // row under review) still claims the transaction holding its ref, so the
  // canonical row can never go clean. The decision sits on another
  // observation of the set-aside charge, which still settles it.
  it.each(["superseded", "ignored"] as const)(
    "lets a %s charge's transaction go to the charge under review",
    async (decision) => {
      await card(ctx);
      const originalInput = rowInput({
        providerTransactionId: "synthetic-set-aside-record",
        rawDescription: "EXAMPLE CAFE 0001",
      });
      await record(ctx, [originalInput]);
      await record(
        ctx,
        [
          rowInput({
            rawDescription: "EXAMPLE CAFE 0002",
            statementDate: "2026-05-05",
          }),
        ],
        { fingerprint: "fp-firmed-up" },
      );
      await generate(ctx);
      const older = (await suggestions(ctx)).find(
        (row) => row.rawDescription === "EXAMPLE CAFE 0001",
      );
      await accept(ctx, older!);
      await record(
        ctx,
        [{ ...originalInput, providerNotes: "Synthetic set-aside revision" }],
        { fingerprint: "fp-older-again" },
      );
      const rowsOf = async (search: string) =>
        (await listSourceTransactionRecords(ctx.db, { search })).data;
      const olderRows = await rowsOf("EXAMPLE CAFE 0001");
      expect(olderRows).toHaveLength(2);
      const [canonical] = await rowsOf("EXAMPLE CAFE 0002");
      const original = olderRows.find(
        (row) => row.importFingerprint === "fp-suggest-1",
      )!;
      const reobserved = olderRows.find(
        (row) => row.importFingerprint === "fp-older-again",
      )!;
      // Another observation of the same charge, not the one the ref names.
      expect(reobserved.externalId).not.toBe(original.externalId);
      expect(reobserved.chargeKey).toBe(original.chargeKey);
      await updateSourceTransactionRecords(
        ctx.db,
        {
          selector: {
            source: "monarch",
            externalIds: [reobserved.externalId],
          },
          data:
            decision === "superseded"
              ? { supersededByExternalId: canonical!.externalId }
              : {
                  disposition: "ignored",
                  dispositionReason: "not_modeled",
                  dispositionNote: "Synthetic duplicate.",
                },
        },
        ctx.actor,
      );
      await generate(ctx);
      await label(
        ctx,
        answering({ kind: "purchase", counterparty: "business" }),
      );
      const second = (await suggestions(ctx)).find(
        (row) => row.rawDescription === "EXAMPLE CAFE 0002",
      );
      expect(second).toMatchObject({
        recommended: "attach",
        clean: true,
        candidates: [expect.objectContaining({ claimed: false })],
      });
    },
  );

  // Failure modes: a category rule alone makes a create bulk-acceptable; a
  // label that disagrees with the rule still leaves it clean.
  it("cleans a create only when a label agrees with the category rule", async () => {
    await card(ctx);
    await record(ctx, [
      rowInput({
        merchant: "Example Cafe",
        rawDescription: "EXAMPLE CAFE",
        sourceCategory: "Coffee Shops",
        providerAmount: -6.25,
      }),
      rowInput({
        merchant: "Example Market",
        rawDescription: "EXAMPLE MARKET",
        sourceCategory: "Shopping",
        providerAmount: -8.5,
      }),
    ]);
    await generate(ctx);
    expect((await suggestions(ctx)).every((row) => !row.clean)).toBe(true);

    await label(
      ctx,
      answering({
        kind: (subject) => (subject.includes("CAFE") ? "purchase" : "fee"),
        counterparty: "business",
      }),
    );
    const rows = await suggestions(ctx);
    expect(rows.find((row) => row.merchant === "Example Cafe")).toMatchObject({
      clean: true,
      create: {
        kind: "purchase",
        kindSource: "rule",
        votes: { rule: "purchase", label: "purchase", history: null },
        counterparty: { label: "business", history: null },
      },
    });
    expect(rows.find((row) => row.merchant === "Example Market")).toMatchObject(
      {
        clean: false,
        create: {
          kind: "purchase",
          votes: { rule: "purchase", label: "fee", history: null },
        },
      },
    );
  });

  // Failure modes: a payment-app credit from a friend under Paychecks becomes
  // clean income; a payment to a person is offered as a transfer or in bulk.
  it("never cleans a payment with a person, in either direction", async () => {
    await card(ctx);
    await record(ctx, [
      rowInput({
        merchant: "Sample Friend",
        rawDescription: "PAYFRIEND FROM SAMPLE FRIEND",
        sourceCategory: "Paychecks",
        providerAmount: 40,
      }),
      rowInput({
        merchant: "Sample Friend",
        rawDescription: "PAYFRIEND *SAMPLE FRIEND",
        sourceCategory: "Shopping",
        providerAmount: -25,
      }),
    ]);
    await generate(ctx);
    await label(
      ctx,
      answering({ kind: "account_transfer", counterparty: "person" }),
    );
    const rows = await suggestions(ctx);
    expect(rows.find((row) => row.amount < 0)).toMatchObject({
      clean: false,
      create: { kind: "income", counterparty: { label: "person" } },
    });
    expect(rows.find((row) => row.amount > 0)).toMatchObject({
      clean: false,
      create: { kind: "purchase", counterparty: { label: "person" } },
    });
  });

  // Failure mode: a card payment labelled clean under the earlier rule keeps
  // its evidence fingerprint (labels ride on top of it), so "Accept clean"
  // would still create it with no opposite leg.
  it("leaves a money move labelled clean by an earlier rule out of Accept clean", async () => {
    const account = (await card(ctx)).output;
    // A clean attach beside it: its create alternative never decides it.
    await createRepoIdentity(ctx, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-05",
      merchant: "Older import label",
      rawDescription: "EXMPL GRCR #1 SYNTHETIC",
      sourceRefs: [],
    });
    await record(ctx, [
      rowInput(),
      rowInput({
        providerAmount: 900,
        merchant: "Synthetic Card Services",
        rawDescription: "PAYMENT THANK YOU",
        sourceCategory: "Credit Card Payment",
      }),
    ]);
    await generate(ctx);
    await label(
      ctx,
      answering({ kind: "credit_card_payment", counterparty: "business" }),
    );
    const listed = await suggestions(ctx);
    const payment = listed.find((row) => row.recommended === "create");
    const attach = listed.find((row) => row.recommended === "attach");
    expect(payment).toMatchObject({
      clean: false,
      create: { kind: "credit_card_payment" },
    });
    expect(attach).toMatchObject({ clean: true });
    // The stored flag the earlier rule left; Accept clean selects by it.
    await getDb(ctx.db).execute(
      sql`UPDATE "AssessmentState" SET data = jsonb_set(data, '{clean}', 'true') WHERE id = ${payment!.assessmentId}::uuid`,
    );
    // Refused with a reason, so the page skips it instead of stopping.
    expect(
      await acceptCleanSuggestions(ctx.db, kernelCtx(ctx), {
        filters: { family: "statement_transaction" },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assessmentId: payment!.assessmentId,
          ok: false,
          error: expect.stringContaining("No longer clean"),
        }),
        expect.objectContaining({
          assessmentId: attach!.assessmentId,
          ok: true,
          applied: true,
        }),
      ]),
    );
    expect(await stateOf(ctx, payment!.assessmentId)).toMatchObject({
      status: "pending",
    });
  });

  // Failure modes: a cash-out from the member's own balance account is read
  // as income from its provider category; a move between two owners is bulk
  // accepted without its LedgerTransfer; a named own account makes a move
  // clean before its opposite leg is seen.
  it("reads a cash-out naming an own balance account as a transfer", async () => {
    const member = await createRepoIdentity(ctx, "ledgerParty", {
      name: "Avery Example",
      kind: "member",
    });
    const partner = await createRepoIdentity(ctx, "ledgerParty", {
      name: "Blake Example",
      kind: "member",
    });
    await createRepoIdentity(ctx, "financialAccount", {
      name: "Synthetic Checking",
      identity: {
        kind: "bank_account",

        accountType: "checking",
      },
      ledgerPartyId: member.output.id,
      sourceAliases: [
        {
          source: "monarch",
          alias: "Synthetic Checking (...1111)",
          externalAccountId: null,
        },
      ],
    });
    const walletProvider = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic Wallet Holdings",
      aliases: ["PayFriend"],
    });
    const partnerProvider = await createRepoIdentity(ctx, "vendor", {
      name: "SplitPay",
    });
    const wallet = await createRepoIdentity(ctx, "financialAccount", {
      name: "Synthetic PayFriend",
      identity: { kind: "stored_value" },
      providerVendorId: walletProvider.output.id,
      ledgerPartyId: member.output.id,
    });
    const partnerWallet = await createRepoIdentity(ctx, "financialAccount", {
      name: "Synthetic SplitPay",
      identity: { kind: "stored_value" },
      providerVendorId: partnerProvider.output.id,
      ledgerPartyId: partner.output.id,
    });
    await record(ctx, [
      rowInput({
        accountDescriptor: "Synthetic Checking (...1111)",
        merchant: "PayFriend",
        rawDescription: "PAYFRIEND CASHOUT 8812",
        sourceCategory: "Other Income",
        providerAmount: 150,
      }),
      rowInput({
        accountDescriptor: "Synthetic Checking (...1111)",
        merchant: "SplitPay",
        rawDescription: "SPLITPAY TRANSFER 7731",
        sourceCategory: "Transfer",
        providerAmount: 60,
      }),
    ]);
    await generate(ctx);
    await label(
      ctx,
      answering({ kind: "account_transfer", counterparty: "business" }),
    );
    const rows = await suggestions(ctx);
    expect(rows.find((row) => row.merchant === "PayFriend")).toMatchObject({
      clean: false,
      create: {
        kind: "account_transfer",
        votes: { rule: "account_transfer", label: "account_transfer" },
      },
      transfer: { accountId: wallet.output.id, ledgerTransfer: false },
    });
    expect(rows.find((row) => row.merchant === "SplitPay")).toMatchObject({
      clean: false,
      create: { kind: "account_transfer" },
      transfer: { accountId: partnerWallet.output.id, ledgerTransfer: true },
    });
  });

  // Failure mode: a payment-app payee whose note reads like a merchant is
  // labelled a business and bulk-accepted.
  it("holds a payment-app payment back on the label alone", async () => {
    await createRepoIdentity(ctx, "financialAccount", {
      name: "Synthetic PayFriend",
      identity: { kind: "stored_value" },
      sourceAliases: [
        {
          source: "monarch",
          alias: "Personal Profile",
          externalAccountId: null,
        },
      ],
    });
    await record(ctx, [
      rowInput({
        accountDescriptor: "Personal Profile",
        merchant: "Sample Friend",
        rawDescription: 'Sample Friend "Noodles"',
        sourceCategory: "Restaurants & Bars",
        providerAmount: -42,
      }),
    ]);
    await generate(ctx);
    await label(ctx, answering({ kind: "purchase", counterparty: "business" }));
    const [row] = await suggestions(ctx);
    expect(row).toMatchObject({
      clean: false,
      create: {
        kind: "purchase",
        votes: { rule: "purchase", label: "purchase", history: null },
        counterparty: { label: "business", history: null, storedValue: true },
      },
    });
  });

  // Failure modes: a card benefit credit naming the same merchant as the
  // subscription it offsets reads that merchant's purchases as `mixed`
  // history, or is proposed as a refund.
  it("keys merchant history on direction for a benefit credit", async () => {
    const account = (await card(ctx)).output;
    const prior = (amount: number, postedDate: string) =>
      createRepoIdentity(ctx, "financialTransaction", {
        accountId: account.id,
        kind: amount > 0 ? "purchase" : "adjustment",
        status: "posted",
        amount,
        postedDate,
        merchant: "Example Rides",
        rawDescription:
          amount > 0 ? "EXAMPLE RIDES PASS" : "EXAMPLE RIDES BENEFIT CREDIT",
        sourceRefs: [],
      });
    for (const postedDate of ["2026-02-03", "2026-03-03"]) {
      await prior(9.99, postedDate);
      await prior(-9.99, postedDate);
    }
    const rides = (providerAmount: number, rawDescription: string) =>
      rowInput({
        merchant: "Example Rides",
        rawDescription,
        sourceCategory: "Taxi & Ride Shares",
        providerAmount,
      });
    await record(ctx, [
      rides(-9.99, "EXAMPLE RIDES PASS"),
      rides(9.99, "SYNTHETIC CARD EXAMPLE RIDES BENEFIT CREDIT"),
    ]);
    await generate(ctx);
    await label(
      ctx,
      answering({
        kind: (subject) =>
          subject.includes("BENEFIT") ? "adjustment" : "purchase",
        counterparty: "business",
      }),
    );
    const rows = await suggestions(ctx);
    expect(rows.find((row) => row.amount > 0)).toMatchObject({
      clean: true,
      create: {
        kind: "purchase",
        votes: { rule: "purchase", label: "purchase", history: "purchase" },
      },
    });
    expect(rows.find((row) => row.amount < 0)).toMatchObject({
      clean: true,
      create: {
        kind: "adjustment",
        votes: { rule: null, label: "adjustment", history: "adjustment" },
      },
    });
  });

  // Failure modes: a rule votes for itself through the transactions its own
  // bulk acceptance created; mixed history reads as agreement.
  it("counts member-made merchant history and excludes rule bulk-accepts", async () => {
    const account = (await card(ctx)).output;
    const prior = (
      merchant: string,
      kind: FinancialTransactionKind,
      postedDate: string,
    ) =>
      createRepoIdentity(ctx, "financialTransaction", {
        accountId: account.id,
        kind,
        status: "posted",
        amount: 9.5,
        postedDate,
        merchant,
        rawDescription: merchant.toUpperCase(),
        sourceRefs: [],
      });
    await prior("Example Bakery", "purchase", "2026-03-02");
    await prior("example  bakery", "purchase", "2026-03-09");
    await prior("Example Deli", "purchase", "2026-03-03");
    await prior("Example Deli", "fee", "2026-03-10");
    const cafe = (statementDate: string, providerAmount: number) =>
      rowInput({
        statementDate,
        merchant: "Example Cafe",
        rawDescription: `EXAMPLE CAFE ${statementDate}`,
        sourceCategory: "Coffee Shops",
        providerAmount,
      });
    // By the third accept two earlier cafe transactions exist: were they
    // counted, its history vote would move and its evidence check refuse it.
    await record(ctx, [
      cafe("2026-03-01", -3.25),
      cafe("2026-03-21", -4.75),
      cafe("2026-04-10", -2.5),
    ]);
    await generate(ctx);
    await label(ctx, answering({ kind: "purchase", counterparty: "business" }));
    while ((await suggestions(ctx)).length) {
      const suggestion = (await suggestions(ctx))[0]!;
      expect(suggestion.clean).toBe(true);
      await accept(ctx, suggestion);
      await generate(ctx);
      await label(
        ctx,
        answering({ kind: "purchase", counterparty: "business" }),
      );
    }

    await record(
      ctx,
      [
        cafe("2026-05-01", -5.5),
        rowInput({
          merchant: "Example Bakery",
          rawDescription: "EXAMPLE BAKERY",
          sourceCategory: "Restaurants",
          providerAmount: -11,
        }),
        rowInput({
          merchant: "Example Deli",
          rawDescription: "EXAMPLE DELI",
          sourceCategory: "Restaurants",
          providerAmount: -13,
        }),
      ],
      { fingerprint: "fp-history-2" },
    );
    await generate(ctx);
    // A low-confidence kind abstains, so rule and history decide.
    await label(
      ctx,
      answering({
        kind: "purchase",
        counterparty: "business",
        kindConfidence: 0.4,
      }),
    );
    const rows = await suggestions(ctx);
    const by = (merchant: string) =>
      rows.find((row) => row.merchant === merchant);
    expect(by("Example Cafe")).toMatchObject({
      clean: false,
      create: { votes: { rule: "purchase", label: null, history: null } },
    });
    expect(by("Example Bakery")).toMatchObject({
      clean: true,
      create: { votes: { rule: "purchase", label: null, history: "purchase" } },
    });
    expect(by("Example Deli")).toMatchObject({
      clean: false,
      create: { votes: { history: "mixed" } },
    });
  });
});
