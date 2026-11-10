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
import {
  suggestionSubjects,
  suggestionProducer,
} from "@cubby/schemas/suggestion";
import { workQueueInput } from "@cubby/schemas/work-queue";
import { DECISION_MODEL } from "@cubby/shared/ai/models";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
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
import { relationalSql } from "~/server/db/helpers/relational-sql";
import {
  suggestionTable,
  runStep,
  expense,
  financialTransaction,
  financialTransactionAllocation,
  spendingCategory,
  sourceOccurrence,
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
import { STATEMENT_SUGGESTION_REVISION } from "~/server/domains/transaction-import/repo/statement-suggestion-revision";
import * as statementSuggestionsRepo from "~/server/domains/transaction-import/repo/statement-suggestions";
import { labelStatementSuggestions as runStatementLabels } from "~/server/domains/transaction-import/service/statement-suggestion-labels";
import * as statementLabelService from "~/server/domains/transaction-import/service/statement-suggestion-labels";
import {
  readWorkQueue,
  readRecordWorkQueue,
} from "~/server/domains/work/service/work-queue-read";
import { currentJobExecution } from "~/server/generic/jobs/context";
import { JobDeferredError } from "~/server/generic/jobs/errors";
import { updateJobs } from "~/server/generic/jobs/jobs.fixtures";
import { cancelJob } from "~/server/generic/jobs/repo/operator";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import * as automaticRuleRuntime from "~/server/generic/suggestions/repo/automatic-application";
import { ruleBase } from "~/server/generic/suggestions/repo/automatic-policy";
import { reviewSuggestion } from "~/server/generic/suggestions/repo/review";
import * as suggestionRepo from "~/server/generic/suggestions/repo/suggestion";
import {
  acceptCleanSuggestions,
  listSuggestionPage,
} from "~/server/generic/suggestions/repo/suggestion-list";
import { transitionSuggestionStates } from "~/server/generic/suggestions/repo/suggestion-state";
import * as suggestionStateRepo from "~/server/generic/suggestions/repo/suggestion-state";
import { buildCrudServices } from "~/server/http/request-context";
import { canonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";
import {
  captureBackgroundQueue,
  drainStoredDerived,
  withJobFixtureExecution,
} from "~/server/testing/background-queue";
import { readSuggestionDecisions } from "~/server/testing/suggestion-decisions.fixtures";
import { withWorkflowExecution } from "~/server/workflows/runs/execution";

import { sourceObservationFrom } from "./source-observation-state";
import {
  getSourceTransactionRecordSummary,
  recordSourceTransactionRecords,
  updateSourceTransactionRecords,
} from "./source-transaction-record";
import { listSourceTransactionRecords } from "./source-transaction-record.fixtures";
import { previewStatementSuggestion } from "./statement-suggestion-preview";
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
  ...(overrides.providerTransactionId
    ? {
        providerAccountId:
          overrides.accountDescriptor ?? "Synthetic Card (...4242)",
        providerData: {
          id: overrides.providerTransactionId,
          account_id: overrides.accountDescriptor ?? "Synthetic Card (...4242)",
        },
      }
    : {}),
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
    where: {
      RAW: (table: PgTable) =>
        relationalSql(
          table,
          eq(spendingCategory.name, "Synthetic statement spending"),
        ),
    },
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

const observedCollections = new WeakMap<object, Map<string, string>>();
let collectionOrder = 0;
const record = async (
  ctx: Ctx,
  rows: SourceTransactionRecordInput[],
  importOverrides: Partial<TransactionImportInput> = {},
) => {
  const collections =
    observedCollections.get(ctx.db) ?? new Map<string, string>();
  const collection = importInput(importOverrides);
  const observedAt =
    collection.observedAt ??
    collections.get(collection.fingerprint) ??
    new Date(Date.UTC(2026, 5, 1) + ++collectionOrder * 1000).toISOString();
  collections.set(collection.fingerprint, observedAt);
  observedCollections.set(ctx.db, collections);
  const receipt = await recordSourceTransactionRecords(
    ctx.db,
    recordSourceTransactionRecordsInput.parse({
      import: { ...collection, observedAt },
      rows,
    }),
    ctx.actor,
  );
  // These label fixtures explicitly review changed provider frontiers. Production intake keeps unordered revisions held.
  for (const row of rows.filter((row) => row.providerTransactionId)) {
    const observations = (
      await listSourceTransactionRecords(ctx.db, { source: collection.source })
    ).data.filter(
      (observation) =>
        observation.providerTransactionId === row.providerTransactionId,
    );
    const head = observations.find(
      (observation) => observation.importFingerprint === collection.fingerprint,
    );
    const previous = observations.find(
      (observation) => observation.id !== head?.id,
    );
    if (head && previous && !head.current)
      await updateSourceTransactionRecords(
        ctx.db,
        {
          selector: {
            source: collection.source,
            externalIds: [previous.externalId],
          },
          data: { supersededByExternalId: head.externalId },
        },
        ctx.actor,
      );
  }
  return receipt;
};

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
  const account = await createRepoIdentity(ctx, "financialAccount", {
    name: "Synthetic Card",
    ledgerPartyId: owner.output.id,

    identity: { kind: "credit_card", network: "visa" },
    sourceAliases: [
      {
        source: "monarch",
        alias: "Synthetic Card (...4242)",
        externalAccountId: "Synthetic Card (...4242)",
      },
    ],
  });
  return { ...account, ledgerPartyId: owner.output.id };
};

const generate = async (ctx: Ctx) => {
  let after = null as Parameters<
    typeof generateStatementSuggestionPage
  >[1]["after"];
  let published = 0;
  for (;;) {
    const page = await generateStatementSuggestionPage(ctx.db, {
      servicesFor: buildCrudServices,
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

const readPendingStatements = async (ctx: Ctx) => {
  const page = await listSuggestionPage(ctx.db, {
    family: "statement_transaction",
    limit: 200,
  });
  return page.items
    .flatMap((row) =>
      row.family === "statement_transaction" ? [row.evidence] : [],
    )
    .sort(
      (a, b) =>
        b.statementDate.localeCompare(a.statementDate) ||
        a.suggestionId.localeCompare(b.suggestionId),
    );
};

const accept = async (
  ctx: Ctx,
  suggestion: StatementSuggestionOut,
  overrides: Partial<StatementTransactionApplication> = {},
  corrected = false,
) => {
  // Unlabelled manual cases explicitly review category/business identity;
  // clean/bulk cases retain the advice carried by their published suggestion.
  const category = await getDb(ctx.db).query.spendingCategory.findFirst({
    where: {
      RAW: (table: PgTable) =>
        relationalSql(
          table,
          eq(spendingCategory.name, "Synthetic statement spending"),
        ),
    },
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
  return reviewSuggestion(ctx.db, kernelCtx(ctx), {
    suggestionId: suggestion.suggestionId,
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

const stateOf = async (ctx: Ctx, suggestionId: string) =>
  (
    await getDb(ctx.db).execute<{ status: string; active: boolean }>(
      sql`SELECT status, active FROM "Suggestion" WHERE id = ${suggestionId}::uuid`,
    )
  ).rows[0];

const label = async (ctx: Ctx, port: DecisionPort) =>
  labelStatementSuggestions(ctx.db, {
    port,
    runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
  });

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
  await client.execute(sql`CREATE TRIGGER synthetic_statement_publication_failure BEFORE INSERT ON "Suggestion"
    FOR EACH ROW EXECUTE FUNCTION synthetic_statement_publication_failure()`);
  return async () => {
    await client.execute(
      sql`DROP TRIGGER synthetic_statement_publication_failure ON "Suggestion"`,
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
    suggestionSubjects.statement_transaction.parse(row.subject),
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
        .update(suggestionTable)
        .set({
          createdAt: new Date(`2026-01-01T00:00:0${order}Z`),
          ...(entry.applicationPending && {
            data: sql`${suggestionTable.data} || ${JSON.stringify({ applicationOrder: { createdAt, id: entry.cursorId } })}::jsonb`,
          }),
        })
        .where(eq(suggestionTable.id, entry.id));
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
      let before: typeof suggestionTable.$inferSelect | undefined;
      const move = async (suggestionId: string) => {
        if (before) return;
        [before] = await getDb(ctx.db)
          .select()
          .from(suggestionTable)
          .where(eq(suggestionTable.id, suggestionId));
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
          if (shortcut && entry) await move(entry.suggestionId);
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
          .from(suggestionTable)
          .where(eq(suggestionTable.id, before.id));
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
      const publishSuggestions = suggestionRepo.publishSuggestions;
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
        .spyOn(suggestionRepo, "publishSuggestions")
        .mockImplementation(async (...args) => {
          if (phase === "publication fallback" && !moved) {
            await move();
            throw new Error("Synthetic batch failure before scoped fallback");
          }
          return publishSuggestions(...args);
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
          .from(suggestionTable)
          .where(eq(suggestionTable.id, before.id));
        expect(
          z.record(z.string(), z.json()).parse(retained?.data)
            .labelCheckpoint ?? null,
        ).toBeNull();
        expect(
          await getDb(ctx.db)
            .select({ id: suggestionTable.id })
            .from(suggestionTable)
            .where(
              sql`${suggestionTable.producer}->>${"kind"} = ${suggestionProducer.shape.kind.enum.model}`,
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
      .from(suggestionTable)
      .where(eq(suggestionTable.id, receipt.receipt.suggestionId));
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
        .from(suggestionTable)
        .where(eq(suggestionTable.id, receipt.receipt.suggestionId)),
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
    const rows = await getDb(ctx.db).execute<{
      source: string;
      chargeKey: string;
    }>(
      sql`SELECT source, "chargeKey" FROM ${sourceObservationFrom} WHERE "deletedAt" IS NULL`,
      "objects",
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
      servicesFor: buildCrudServices,
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
          revision: STATEMENT_SUGGESTION_REVISION,
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
    const account = await card(ctx);
    const unrelatedAccount = await createRepoIdentity(ctx, "financialAccount", {
      name: "Synthetic unrelated card",
      ledgerPartyId: account.ledgerPartyId,
      identity: { kind: "credit_card", network: "visa" },
    });
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
    ).toMatchObject({ unmatched: 2, unmatchedCharges: 2 });

    expect(await generate(ctx)).toBe(2);
    expect(await generate(ctx)).toBe(0);
    await drainStoredDerived(ctx.db);
    const queue = await readWorkQueue(ctx.db, {
      input: workQueueInput.parse({ pageSize: 100 }),
      memberPartyId: null,
      memberOnly: false,
    });
    // Pending statement proposals share one row for their source account.
    expect(
      queue.items.filter((row) =>
        row.reasonKeys.includes("suggestions:statement_transaction"),
      ),
    ).toEqual([
      expect.objectContaining({
        entity: "financialAccount",
        reason: "Pending suggestions",
      }),
    ]);
    const recordWork = await readRecordWorkQueue(ctx.db, {
      id: account.output.id,
      memberPartyId: null,
      memberOnly: false,
    });
    expect(
      recordWork.items.some((row) =>
        row.reasonKeys.includes("suggestions:statement_transaction"),
      ),
    ).toBe(true);
    const unrelatedWork = await readRecordWorkQueue(ctx.db, {
      id: unrelatedAccount.output.id,
      memberPartyId: null,
      memberOnly: false,
    });
    expect(
      unrelatedWork.items.some((row) =>
        row.reasonKeys.includes("suggestions:statement_transaction"),
      ),
    ).toBe(false);
    const [first] = (await readPendingStatements(ctx)).filter(
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
    // Background read publication follows the ignore without retiring history.
    expect(
      (await readPendingStatements(ctx)).map((row) => row.merchant),
    ).toEqual(["Example Grocer"]);
    expect(await stateOf(ctx, first!.suggestionId)).toMatchObject({
      status: "pending",
      active: true,
    });
    const remainingWork = await readWorkQueue(ctx.db, {
      input: workQueueInput.parse({
        reason: "suggestions:statement_transaction",
      }),
      memberPartyId: null,
      memberOnly: false,
    });
    expect(remainingWork.items).toHaveLength(1);
    expect(remainingWork.items[0]?.reason).toBe("Pending suggestions");
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
    const rows = await getDb(ctx.db).execute<{
      source: string;
      externalId: string;
      chargeKey: string;
    }>(
      sql`
      SELECT source,"externalId","chargeKey" FROM ${sourceObservationFrom}
      WHERE "deletedAt" IS NULL ORDER BY source,"chargeKey"`,
      "objects",
    );
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
      servicesFor: buildCrudServices,
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
      servicesFor: buildCrudServices,
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
        servicesFor: buildCrudServices,
        runId: null,
        after: second.next,
        limit: 1,
      }),
    ).toMatchObject({ processed: 0, failed: [], next: null });
    expect(
      (await readPendingStatements(ctx)).map((row) => row.chargeKey).sort(),
    ).toEqual([rows[2]!.chargeKey, rows[4]!.chargeKey].sort());
  });

  it("holds overlapping unattested collections without creating member work or changing money", async () => {
    await card(ctx);
    const observed = rowInput({ rowPosition: 1 });
    await record(ctx, [observed], { fingerprint: "synthetic-idless-first" });
    await record(ctx, [observed], { fingerprint: "synthetic-idless-second" });
    const retained = (await listSourceTransactionRecords(ctx.db, {})).data;
    expect(retained).toHaveLength(2);
    expect(new Set(retained.map((row) => row.chargeKey)).size).toBe(2);
    await generate(ctx);
    expect(await readPendingStatements(ctx)).toHaveLength(1);
    expect(retained.every((row) => row.transactionId === null)).toBe(true);
    expect(retained.map((row) => row.matchState).sort()).toEqual([
      "held",
      "unmatched",
    ]);
    expect(await getDb(ctx.db).select().from(financialTransaction)).toEqual([]);
  });

  // Failure modes: the settlement-ref trigger supersedes the suggestion being
  // applied; a second accept creates a twin; the row stays unmatched.
  it("creates the transaction, ends applied, and refuses a replay", async () => {
    await card(ctx);
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const [suggestion] = await readPendingStatements(ctx);
    const outcome = await accept(ctx, suggestion!);
    expect(outcome).toMatchObject({ status: "applied", applied: true });
    expect(await stateOf(ctx, suggestion!.suggestionId)).toMatchObject({
      status: "applied",
      active: true,
    });
    const [row] = (await listSourceTransactionRecords(ctx.db, {})).data;
    expect(row).toMatchObject({ matchState: "matched" });
    expect(row?.accountId).toMatch(/^FAC-/);
    await expect(accept(ctx, suggestion!)).rejects.toThrow(
      /already resolved|no longer pending/,
    );
    expect(await readPendingStatements(ctx)).toEqual([]);
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
    const [suggestion] = await readPendingStatements(ctx);
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
    const [suggestion] = await readPendingStatements(ctx);
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
    expect(await stateOf(ctx, suggestion!.suggestionId)).toMatchObject({
      status: "pending",
    });
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
    const [hold] = await readPendingStatements(ctx);
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
    const [posted] = await readPendingStatements(ctx);
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
        .select({
          amount:
            sql<number>`${financialTransactionAllocation.amountMinor}::numeric / 100`.mapWith(
              Number,
            ),
        })
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
    const charges = await getDb(ctx.db).execute<{
      source: string;
      chargeKey: string;
    }>(
      sql`
      SELECT source, "chargeKey"
      FROM ${sourceObservationFrom} WHERE "deletedAt" IS NULL ORDER BY source, "chargeKey"
    `,
      "objects",
    );
    const removeFailure = await rejectStatementPublication(
      ctx,
      charges[0]!.chargeKey,
    );
    try {
      const first = await generateStatementSuggestionPage(ctx.db, {
        servicesFor: buildCrudServices,
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
        servicesFor: buildCrudServices,
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
        servicesFor: buildCrudServices,
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
        servicesFor: buildCrudServices,
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
          servicesFor: buildCrudServices,
          runId: null,
          refs: first.failed.flatMap((failure) =>
            failure.ref ? [failure.ref] : [],
          ),
        }),
      ).toMatchObject({ done: 1, skipped: 0, failed: [] });
      const missing = await retryStatementGenerationRefs(ctx.db, {
        servicesFor: buildCrudServices,
        runId: null,
        refs: ["charge:synthetic:missing"],
      });
      expect(missing).toMatchObject({
        done: 0,
        skipped: 0,
        failed: [
          {
            ref: "charge:synthetic:missing",
            message: expect.stringContaining("requires source identity"),
          },
        ],
      });
      expect(await readPendingStatements(ctx)).toHaveLength(7);
    } finally {
      await removeFailure();
    }
  });

  it("recovers missed retirement even when settled transfer evidence produces no proposal", async () => {
    const account = (await card(ctx)).output;
    await record(ctx, [rowInput()]);
    await generateStatementSuggestionPage(ctx.db, {
      servicesFor: buildCrudServices,
      after: null,
      runId: null,
    });
    const [pending] = await readPendingStatements(ctx);
    const [observation] = (await listSourceTransactionRecords(ctx.db, {})).data;
    if (!pending || !observation)
      throw new Error("Missing synthetic recovery evidence");
    await updateSourceTransactionRecords(
      ctx.db,
      {
        selector: {
          source: observation.source,
          externalIds: [observation.externalId],
        },
        data: { accountId: account.id },
      },
      ctx.actor,
    );
    await createRepoIdentity(ctx, "financialTransaction", {
      accountId: account.id,
      kind: "account_transfer",
      status: "posted",
      amount: 42.5,
      transactionDate: "2026-05-04",
      postedDate: "2026-05-04",
      sourceRefs: [
        { source: observation.source, externalId: observation.chargeKey },
      ],
    });
    // Recreate only the stale projection a missed after-commit retirement left.
    await getDb(ctx.db)
      .update(suggestionTable)
      .set({ active: true, status: "pending" })
      .where(eq(suggestionTable.id, pending.suggestionId));
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
      servicesFor: buildCrudServices,
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
        .select({ active: suggestionTable.active })
        .from(suggestionTable)
        .where(eq(suggestionTable.id, pending.suggestionId)),
    ).toEqual([{ active: true }]);
    expect(
      await retryStatementGenerationRefs(ctx.db, {
        servicesFor: buildCrudServices,
        runId: null,
        refs: [`charge:${charge.source}:${charge.chargeKey}`],
      }),
    ).toMatchObject({ done: 1, skipped: 0, failed: [] });
    expect(
      await getDb(ctx.db)
        .select({
          active: suggestionTable.active,
          status: suggestionTable.status,
        })
        .from(suggestionTable)
        .where(eq(suggestionTable.id, pending.suggestionId)),
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
    await updateSourceTransactionRecords(
      ctx.db,
      {
        selector: {
          source: observation.source,
          externalIds: [observation.externalId],
        },
        data: { accountId: account.id },
      },
      ctx.actor,
    );
    await createRepoIdentity(ctx, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "void",
      amount: 42.5,
      transactionDate: "2026-05-04",
      sourceRefs: [
        { source: observation.source, externalId: observation.chargeKey },
      ],
    });
    await generate(ctx);
    const rows = await readPendingStatements(ctx);
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
    expect(await readPendingStatements(ctx)).toHaveLength(1);
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
    const [proposal] = await readPendingStatements(ctx);
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
    expect(await readPendingStatements(ctx)).toMatchObject([
      { clean: false, reviewReason: expect.any(String) },
    ]);
    const [held] = await readPendingStatements(ctx);
    if (!held?.reviewReason) throw new Error("Missing source lifecycle hold");
    await expect(
      previewStatementSuggestion(ctx.db, {
        suggestionId: held.suggestionId,
        expectedFingerprint: held.fingerprint,
        application: { kind: "statement_transaction", action: "book" },
      }),
    ).rejects.toThrow(held.reviewReason);
    await expect(accept(ctx, held)).rejects.toThrow(held.reviewReason);
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
    const [hold] = await readPendingStatements(ctx);
    await accept(ctx, hold!);
    await generate(ctx);
    expect(await readPendingStatements(ctx)).toEqual([]);

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
    await generateStatementSuggestionPage(ctx.db, {
      servicesFor: buildCrudServices,
      after: null,
      runId: null,
    });
    expect(
      (await readPendingStatements(ctx)).filter(
        (row) => row.recommended === "void",
      ),
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
      (await readPendingStatements(ctx)).filter(
        (row) => row.recommended === "void",
      ),
    ).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select({
          status: financialTransaction.status,
          amount: financialTransaction.amount,
        })
        .from(financialTransaction)
        .where(notDeleted(financialTransaction)),
    ).toEqual([{ status: "pending", amount: 30_000n }]);
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

  // Physical positions prove genuine purchases; historical membership and
  // Unicode descriptor differences must not hide an unresolved extra occurrence.
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
    const [proposal] = await readPendingStatements(ctx);
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
    const [rule] = await readPendingStatements(ctx);
    expect(rule).toMatchObject({ recommended: "attach", clean: false });
    expect(
      await labelStatementSuggestions(ctx.db, {
        port: answering({ kind: "purchase", counterparty: "business" }),
        runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
      }),
    ).toMatchObject({ labelled: 1 });
    const [labelled] = await readPendingStatements(ctx);
    expect(labelled).toMatchObject({
      recommended: "attach",
      clean: true,
      candidates: [{ label: { same: "same", confidence: "high" } }],
    });
    expect(labelled!.model).not.toBeNull();
    expect(await stateOf(ctx, rule!.suggestionId)).toMatchObject({
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
      },
      async () => {
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
        const subject = suggestionSubjects.statement_transaction.parse(
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

  // Regression #3397: an inclusive cursor reread charges the step had already
  // counted failed, so a Sweep reported more processed labels than its total.
  it("skips charges this step generation already counted as failed", async () => {
    await card(ctx);
    await record(ctx, [
      rowInput({ rawDescription: "SYNTHETIC COUNTED", providerAmount: -11 }),
      rowInput({ rawDescription: "SYNTHETIC FRESH", providerAmount: -12 }),
    ]);
    await generate(ctx);
    const pending = await statementSuggestionsRepo.suggestionsNeedingLabels(
      ctx.db,
      10,
    );
    expect(pending).toHaveLength(2);
    const [counted] = pending.map((row) =>
      suggestionSubjects.statement_transaction.parse(row.subject),
    );
    const result = await runStatementLabels(ctx.db, {
      runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
      port: answering({ kind: "purchase", counterparty: "business" }),
      spendingAdvice: await statementSpendingAdvice(ctx.db),
      countedFailures: new Set([
        `charge:${counted!.source}:${counted!.chargeKey}`,
      ]),
    });
    expect(result).toMatchObject({ completed: 1, failed: [] });
    expect(
      await statementSuggestionsRepo.suggestionsNeedingLabels(ctx.db, 10),
    ).toMatchObject([{ subject: expect.objectContaining(counted) }]);
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

    const retained = await record(
      ctx,
      [
        rowInput({ providerTransactionId: "synthetic-deadline-receipt-a" }),
        rowInput({ providerTransactionId: "synthetic-deadline-receipt-b" }),
      ],
      { fingerprint: "synthetic-application-deadline" },
    );
    await generate(ctx);
    await statementSuggestionsRepo.publishCompleteStatementLabels(
      ctx.db,
      await completeLabelPublications(ctx),
    );
    const noMoreQuestions = async () => {
      throw new Error("Retained application must reuse committed labels");
    };
    let application;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      application = await runStatementLabels(ctx.db, {
        cooperative: true,
        scope: { importId: retained.batchId },
        port: noMoreQuestions,
        work: {
          add() {},
          async time(phase, run) {
            if (phase === "statement_application")
              vi.setSystemTime(Date.now() + 21_000);
            return run();
          },
        },
      });
      expect(application).toMatchObject({
        completed: 1,
        failed: [],
        next: { inclusive: true },
      });
      expect(
        await statementSuggestionsRepo.suggestionsNeedingLabels(
          ctx.db,
          10,
          application.next,
          { importId: retained.batchId },
        ),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
    expect(
      await runStatementLabels(ctx.db, {
        after: application.next,
        scope: { importId: retained.batchId },
        port: noMoreQuestions,
      }),
    ).toMatchObject({ completed: 1, failed: [], next: null });
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
    expect(
      (await readPendingStatements(ctx))[0]!.create!.votes.label,
    ).toBeNull();
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
        const [complete] = await readPendingStatements(ctx);
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

  it("dismisses only the current financial recommendation and allows changed evidence", async () => {
    await card(ctx);
    const observed = rowInput({
      providerTransactionId: "synthetic-revision-dismissal",
    });
    await record(ctx, [observed]);
    const [legacyOwner] = await getDb(ctx.db)
      .select({
        id: sourceOccurrence.id,
        version: sourceOccurrence.version,
        reviewState: sourceOccurrence.reviewState,
        currentObservationId: sourceOccurrence.currentObservationId,
        acceptedTransactionId: sourceOccurrence.acceptedTransactionId,
      })
      .from(sourceOccurrence);
    const [legacyRecord] = (await listSourceTransactionRecords(ctx.db, {}))
      .data;
    if (!legacyOwner || !legacyRecord)
      throw new Error("Synthetic predecessor evidence missing");
    // Frozen predecessor hash: removing a presentation field must not revive unchanged dismissed advice.
    const predecessorOwnerHash = await sha256Hex(
      canonicalJson(jsonSnapshot.parse({ ...legacyOwner, suppressed: false })),
    );
    const [proposal] = await buildChargeProposals(ctx.db, [
      { source: legacyRecord.source, chargeKey: legacyRecord.chargeKey },
    ]);
    expect(proposal?.providerScopeFingerprint).toBe(predecessorOwnerHash);
    await generate(ctx);
    await label(ctx, answering({ kind: "purchase", counterparty: "business" }));
    const [current] = await readPendingStatements(ctx);
    const [bankRecord] = (await listSourceTransactionRecords(ctx.db, {})).data;
    if (!current || !bankRecord)
      throw new Error("Synthetic current financial recommendation missing");
    await reviewSuggestion(ctx.db, kernelCtx(ctx), {
      operationId: "synthetic-current-dismissal",
      suggestionId: current.suggestionId,
      verdict: "dismissed",
      intent: "history",
      suppression: {
        scope: "statement_transaction",
        candidateKey: `${bankRecord.source}:${bankRecord.chargeKey}`,
        fingerprint: null,
      },
      evidence: { note: "Dismiss this recommendation, not the bank event" },
    });
    const [dismissed] = await getDb(ctx.db)
      .select()
      .from(suggestionTable)
      .where(eq(suggestionTable.id, current.suggestionId));
    expect(dismissed?.suppression?.fingerprint).toBe(dismissed?.fingerprint);
    await generate(ctx);
    expect(await readPendingStatements(ctx)).toEqual([]);
    const [retainedDismissal] = await getDb(ctx.db)
      .select()
      .from(suggestionTable)
      .where(eq(suggestionTable.id, current.suggestionId));
    expect(retainedDismissal).toMatchObject({
      active: true,
      status: "resolved",
      data: { evidenceFingerprint: proposal?.evidenceFingerprint },
    });
    expect(await getDb(ctx.db).select().from(financialTransaction)).toEqual([]);
    await getDb(ctx.db)
      .update(suggestionTable)
      .set({
        producer: sql`jsonb_set(${suggestionTable.producer},'{revision}',to_jsonb(${"synthetic-old-label-revision"}::text))`,
      })
      .where(eq(suggestionTable.id, current.suggestionId));
    await generate(ctx);
    expect(await readPendingStatements(ctx)).toEqual([]);
    await record(
      ctx,
      [
        {
          ...observed,
          rowPosition: 10,
          providerAmount: -45.5,
          rawDescription: "SYNTHETIC REVISED CHARGE",
        },
      ],
      { fingerprint: "synthetic-dismissal-revision" },
    );
    await generate(ctx);
    await label(ctx, answering({ kind: "purchase", counterparty: "business" }));
    const pending = await readPendingStatements(ctx);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.suggestionId).not.toBe(current.suggestionId);
    expect(
      (await listSourceTransactionRecords(ctx.db, {})).data.every(
        (row) => row.disposition === "open",
      ),
    ).toBe(true);
    expect(await getDb(ctx.db).select().from(financialTransaction)).toEqual([]);
  });

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
    const [before] = await readPendingStatements(ctx);
    expect(before).toMatchObject({
      clean: true,
      create: {
        votes: { label: "purchase" },
        counterparty: { label: "business" },
      },
    });
    const [original] = (await listSourceTransactionRecords(ctx.db, {})).data;
    if (!original?.legacyExternalId)
      throw new Error("Synthetic retained alias missing");
    const legacyKey = original.legacyExternalId;
    await getDb(ctx.db).execute(
      sql`UPDATE "Suggestion" SET data=jsonb_set(data,'{chargeKey}',to_jsonb(${legacyKey}::text)), subject=jsonb_set(subject,'{chargeKey}',to_jsonb(${legacyKey}::text)) WHERE id=${before!.suggestionId}::uuid`,
    );
    await expect(accept(ctx, before!)).rejects.toThrow(/explicit review/);
    await record(
      ctx,
      [{ ...observed, rowPosition: 10, providerNotes: "Synthetic memo" }],
      {
        fingerprint: "synthetic-reexport",
      },
    );
    const regenerated = await generateStatementSuggestionPage(ctx.db, {
      servicesFor: buildCrudServices,
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
    const [after] = await readPendingStatements(ctx);
    expect(after).toMatchObject({
      clean: true,
      create: {
        votes: { label: "purchase" },
        counterparty: { label: "business" },
        notes: "Synthetic memo",
      },
      model: before!.model,
    });
    expect(await stateOf(ctx, before!.suggestionId)).toMatchObject({
      active: false,
      status: "superseded",
    });
    await reviewSuggestion(ctx.db, kernelCtx(ctx), {
      operationId: "synthetic-obsolete-dismissal",
      suggestionId: before!.suggestionId,
      verdict: "dismissed",
      intent: "history",
      suppression: {
        scope: "statement_transaction",
        candidateKey: `${original.source}:${legacyKey}`,
        fingerprint: null,
      },
      evidence: { note: "Dismiss obsolete held advice only" },
    });
    const [obsolete] = await getDb(ctx.db)
      .select({ suppression: suggestionTable.suppression })
      .from(suggestionTable)
      .where(eq(suggestionTable.id, before!.suggestionId));
    expect(obsolete?.suppression).toBeNull();
    expect(await readPendingStatements(ctx)).toHaveLength(1);
    await accept(ctx, after!);
    expect(
      (await listSourceTransactionRecords(ctx.db, {})).data
        .filter((row) => row.current)
        .every((row) => row.matchState === "matched"),
    ).toBe(true);
  });

  // Prompt instructions are model inputs too; an obsolete producer revision
  // cannot be kept merely because the charge's evidence fingerprint matches.
  it("relabels an obsolete prompt revision even when evidence is unchanged", async () => {
    await card(ctx);
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const [existing] = await readPendingStatements(ctx);
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
      .select({ data: suggestionTable.data })
      .from(suggestionTable)
      .where(
        and(
          eq(suggestionTable.family, "statement_transaction"),
          eq(suggestionTable.active, true),
        ),
      );
    expect(publishedCheckpoint?.data).toMatchObject({
      labelCheckpoint: { models: ["synthetic-decision-model"] },
    });
    await generate(ctx);
    const [rebuilt] = await readPendingStatements(ctx);
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
      const [rebuilt] = await readPendingStatements(ctx);
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
        (await readPendingStatements(ctx)).every(
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
        where: {
          RAW: (table: PgTable) =>
            relationalSql(
              table,
              eq(spendingCategory.name, "Synthetic statement spending"),
            ),
        },
      });
      if (!category) throw new Error("Synthetic spending category is missing");
      const labelled = await readPendingStatements(ctx);
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
    const publish = suggestionRepo.publishSuggestions;
    const releasePublications = Promise.withResolvers<void>();
    let publicationDb: Parameters<typeof publish>[0] | undefined;
    let claim:
      | NonNullable<ReturnType<typeof currentJobExecution>>["claim"]
      | undefined;
    let renewal: Promise<boolean> | undefined;
    let renewalQueued = false;
    let publicationsAfterQueue = 0;
    const batchSizes: number[] = [];
    const spy = vi
      .spyOn(suggestionRepo, "publishSuggestions")
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
      if (!owner || !publicationDb)
        throw new Error("Expected real Job publications");
      // Held publications take the Job row lock only at commit, so the
      // heartbeat renews while all four still wait.
      renewal = databaseHelpers.withTransactionDatabase(
        ctx.db,
        async (tx) =>
          (
            await updateJobs(
              tx,
              { id: owner.id },
              { leaseExpiresAt: new Date(Date.now() + 60_000) },
            )
          ).length === 1,
      );
      expect(await renewal).toBe(true);
      renewalQueued = true;
      releasePublications.resolve();
      const outcome = await pending;
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
        credit: { spentUsd: 0 },
        openaiCredit: { spentUsd: 0 },
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
    const pending = (await readPendingStatements(ctx)).find(
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
        suggestionId: result.receipt.suggestionId,
        charge: entry.proposal.charge,
        evidenceFingerprint: result.receipt.evidenceFingerprint,
      };
    });
    const ids = targets.map((entry) => entry.suggestionId);
    await databaseHelpers.withTransactionDatabase(ctx.db, async (tx) => {
      await transitionSuggestionStates(
        tx,
        inArray(suggestionTable.id, ids),
        (row) => ({
          data: {
            ...z.record(z.string(), z.json()).parse(row.data),
            matchedRules:
              row.id === targets[2]!.suggestionId
                ? ["statement_transaction.attach@synthetic"]
                : row.id === targets[1]!.suggestionId
                  ? [ruleBase("statement_transaction.book_spending")]
                  : row.id === targets[3]!.suggestionId
                    ? ["statement_transaction.book_spending@synthetic-obsolete"]
                    : [],
          },
        }),
      );
    });
    const read = () =>
      getDb(ctx.db)
        .select()
        .from(suggestionTable)
        .where(inArray(suggestionTable.id, ids))
        .orderBy(suggestionTable.id);
    const before = await read();
    const eventsBefore = await readSuggestionDecisions(ctx.db);
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
    expect(await readSuggestionDecisions(ctx.db)).toEqual(eventsBefore);
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
      const row = after.find((row) => row.id === target.suggestionId)!;
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
          suggestionId: outcome.receipt.suggestionId,
          charge: entry.proposal.charge,
          evidenceFingerprint: outcome.receipt.evidenceFingerprint,
        },
      ];
      const before = await getDb(ctx.db)
        .select()
        .from(suggestionTable)
        .where(eq(suggestionTable.id, targets[0]!.suggestionId));
      const beforeEvents = await readSuggestionDecisions(ctx.db);
      const transition = suggestionStateRepo.transitionSuggestionStates;
      const writes = vi
        .spyOn(suggestionStateRepo, "transitionSuggestionStates")
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
            async (context) => {
              const owner = currentJobExecution();
              if (!owner) throw new Error("Expected real Job execution");
              if (failure === "cancelled")
                await cancelJob(ctx.db, owner.claim.id);
              // Sweep steps run inside the Run's workflow, which carries the fence.
              return withWorkflowExecution(
                { runId: crypto.randomUUID(), attempt: 1, job: context },
                () =>
                  statementSuggestionsRepo.completeNoActionStatementPrefix(
                    ctx.db,
                    targets,
                  ),
              );
            },
          ),
        ).rejects.toThrow("Job generation or lease is obsolete");
        expect(
          await getDb(ctx.db)
            .select()
            .from(suggestionTable)
            .where(eq(suggestionTable.id, targets[0]!.suggestionId)),
        ).toEqual(before);
        expect(await readSuggestionDecisions(ctx.db)).toEqual(beforeEvents);
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
    const publication = vi.spyOn(suggestionRepo, "publishSuggestions");
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
      expect(pending!.id).toBe(receipt.receipt.suggestionId);
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
    const publication = vi.spyOn(suggestionRepo, "publishSuggestions");
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
            suggestionId: row.id,
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
      const publish = suggestionRepo.publishSuggestions;
      const publication = vi
        .spyOn(suggestionRepo, "publishSuggestions")
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
            async (context) => {
              const owner = currentJobExecution();
              if (!owner) throw new Error("Expected real Job execution");
              if (failure === "cancelled")
                await cancelJob(ctx.db, owner.claim.id);
              // Sweep steps run inside the Run's workflow, which carries the fence.
              return withWorkflowExecution(
                { runId: crypto.randomUUID(), attempt: 1, job: context },
                () =>
                  statementSuggestionsRepo.publishCompleteStatementLabels(
                    ctx.db,
                    entries,
                  ),
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
    const charges = (await readPendingStatements(ctx)).map(
      ({ source, chargeKey }) => ({
        source,
        chargeKey,
      }),
    );
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
    const [before] = await readPendingStatements(ctx);
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
    expect(await readPendingStatements(ctx)).toEqual([]);
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
    expect(await readPendingStatements(ctx)).toEqual([]);
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
    const [fresh] = await readPendingStatements(ctx);
    expect(fresh).toMatchObject({
      chargeKey: before!.chargeKey,
      amount: 48,
      create: { merchant: "Synthetic changed evidence", amount: 48 },
    });
    expect(fresh!.fingerprint).not.toBe(before!.fingerprint);
  });

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
    const charge = suggestionSubjects.statement_transaction.parse(
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
      charge: suggestionSubjects.statement_transaction.parse(
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
      .update(suggestionTable)
      .set({ createdAt: new Date("2026-01-01T00:00:00Z") })
      .where(eq(suggestionTable.id, overflowing.id));
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
    expect(
      (await readPendingStatements(ctx))[0]!.create!.votes.label,
    ).toBeNull();
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
    const [pending] = await readPendingStatements(ctx);
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
    const [before] = await readPendingStatements(ctx);
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
        credit: { spentUsd: 0 },
        openaiCredit: { spentUsd: 0 },
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
    const retained = (await readPendingStatements(ctx)).find(
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
    expect((await readPendingStatements(ctx)).every((row) => row.clean)).toBe(
      true,
    );
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
    const [suggestion] = await readPendingStatements(ctx);
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
      servicesFor: buildCrudServices,
      after: null,
      runId: null,
      scope: { importId: later.batchId },
    });
    expect(page).toMatchObject({ published: 1, next: null });
    expect(
      (await readPendingStatements(ctx)).map((row) => row.rawDescription),
    ).toEqual(["EXAMPLE NEWER CHARGE"]);
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
        .update(suggestionTable)
        .set({
          createdAt: new Date(Date.UTC(2026, 0, 1) + seconds * 1000),
          data: sql`${suggestionTable.data} || ${JSON.stringify(extra)}::jsonb`,
        })
        .where(eq(suggestionTable.id, target(index).id));
    }
    // A withdrawn head is absent unless its retained correction review allows it.
    for (const index of [6, 7])
      await getDb(ctx.db)
        .update(sourceOccurrence)
        .set({ withdrawnAt: new Date() })
        .where(
          sql`${sourceOccurrence.shortcode}=(SELECT data->>'chargeKey' FROM "Suggestion" WHERE id=${target(index).id}::uuid)`,
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

  // Failure modes: a ref attached on another path (the import page, an
  // agent's entity.update) leaves the suggestion live, and accepting it
  // records the charge twice.
  it("hides and refuses stale evidence when its charge is attached elsewhere", async () => {
    const account = (await card(ctx)).output;
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const [suggestion] = await readPendingStatements(ctx);
    const [row] = (await listSourceTransactionRecords(ctx.db, {})).data;
    if (!row) throw new Error("Synthetic source missing");
    await updateSourceTransactionRecords(
      ctx.db,
      {
        selector: { source: row.source, externalIds: [row.externalId] },
        data: { accountId: account.id },
      },
      ctx.actor,
    );
    await createRepoIdentity(ctx, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-04",
      merchant: "Example Grocer",
      rawDescription: "EXAMPLE GROCER 0001",
      sourceRefs: [{ source: "monarch", externalId: row!.chargeKey }],
    });
    expect(await stateOf(ctx, suggestion!.suggestionId)).toMatchObject({
      status: "pending",
      active: true,
    });
    expect(await readPendingStatements(ctx)).toEqual([]);
    await expect(accept(ctx, suggestion!)).rejects.toThrow(
      /evidence changed|stale/,
    );
    // Republication, not a scanner, replaces the stale advice.
    expect(await generate(ctx)).toBe(1);
    expect(await stateOf(ctx, suggestion!.suggestionId)).toMatchObject({
      status: "superseded",
      active: false,
    });
    expect((await readPendingStatements(ctx))[0]).toMatchObject({
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
    const [suggestion] = await readPendingStatements(ctx);
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
    const [first] = await readPendingStatements(ctx);
    await accept(ctx, first!);
    const [twin] = await readPendingStatements(ctx);
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
    const older = (await readPendingStatements(ctx)).find(
      (row) => row.rawDescription === "EXAMPLE CAFE 0001",
    );
    await accept(ctx, older!);
    await label(ctx, answering({ kind: "purchase", counterparty: "business" }));
    const [second] = await readPendingStatements(ctx);
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

  // Regression #3396: provider rows without statement text matched every
  // nearby transaction because two empty descriptions compared equal.
  it("does not offer an unrelated nearby transaction when both descriptions are empty", async () => {
    await card(ctx);
    await record(ctx, [
      rowInput({
        merchant: "Example Hotel",
        rawDescription: "",
        providerAmount: -4.19,
      }),
    ]);
    await generate(ctx);
    const [booked] = await readPendingStatements(ctx);
    await accept(ctx, booked!);
    await record(
      ctx,
      [
        rowInput({
          merchant: "Example Shop",
          rawDescription: "",
          providerAmount: -16.26,
          statementDate: "2026-05-06",
        }),
      ],
      { fingerprint: "fp-unrelated" },
    );
    await generate(ctx);
    const unrelated = (await readPendingStatements(ctx)).find(
      (row) => row.merchant === "Example Shop",
    );
    expect(unrelated).toMatchObject({ recommended: "create", candidates: [] });
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
      const older = (await readPendingStatements(ctx)).find(
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
      const second = (await readPendingStatements(ctx)).find(
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
    expect((await readPendingStatements(ctx)).every((row) => !row.clean)).toBe(
      true,
    );

    await label(
      ctx,
      answering({
        kind: (subject) => (subject.includes("CAFE") ? "purchase" : "fee"),
        counterparty: "business",
      }),
    );
    const rows = await readPendingStatements(ctx);
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
    const rows = await readPendingStatements(ctx);
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
    const listed = await readPendingStatements(ctx);
    const payment = listed.find((row) => row.recommended === "create");
    const attach = listed.find((row) => row.recommended === "attach");
    expect(payment).toMatchObject({
      clean: false,
      create: { kind: "credit_card_payment" },
    });
    expect(attach).toMatchObject({ clean: true });
    // Reproduce an older successful publication's clean selection operands.
    // The action must recheck current advice even when bulk selects this row.
    await getDb(ctx.db).execute(
      sql`UPDATE "Suggestion" SET data = jsonb_set(data, '{clean}', 'true') WHERE id = ${payment!.suggestionId}::uuid`,
    );
    // Refused with a reason, so the page skips it instead of stopping.
    expect(
      await acceptCleanSuggestions(ctx.db, kernelCtx(ctx), {
        filters: { family: "statement_transaction" },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          suggestionId: payment!.suggestionId,
          ok: false,
          error: expect.stringContaining("No longer clean"),
        }),
        expect.objectContaining({
          suggestionId: attach!.suggestionId,
          ok: true,
          applied: true,
        }),
      ]),
    );
    expect(await stateOf(ctx, payment!.suggestionId)).toMatchObject({
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
    const rows = await readPendingStatements(ctx);
    expect(rows.find((row) => row.merchant === "PayFriend")).toMatchObject({
      clean: false,
      create: {
        kind: "account_transfer",
        votes: { rule: "account_transfer", label: null },
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
    const [row] = await readPendingStatements(ctx);
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
    const rows = await readPendingStatements(ctx);
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
    for (;;) {
      const [suggestion] = await readPendingStatements(ctx);
      if (!suggestion) break;
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
    const rows = await readPendingStatements(ctx);
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
