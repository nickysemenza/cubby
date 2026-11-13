import { suggestionStatus } from "@cubby/schemas/ai";
import { financialSpendingAdvice } from "@cubby/schemas/financial-booking";
import {
  recordSourceTransactionRecordsInput,
  type TransactionImportInput,
  type SourceTransactionRecordInput,
} from "@cubby/schemas/source-transaction-record";
import {
  STATEMENT_ANSWER_VERSIONS,
  statementMerchantIdentityInput,
  statementMerchantSupportInput,
} from "@cubby/schemas/statement-answers";
import {
  statementTransactionJudgment,
  type StatementSuggestionOut,
  type StatementTransactionApplication,
} from "@cubby/schemas/statement-suggestion";
import { suggestionFamily } from "@cubby/schemas/suggestion";
import { workQueueInput } from "@cubby/schemas/work-queue";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { createEntity } from "tooling/factories/create";
import { createRepoIdentity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { expectStatementBudget } from "tooling/statement-budget";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AiBudgetExhaustedError } from "~/server/ai/budget";
import type { DecisionPort } from "~/server/ai/decision-model";
import { getDb, notDeleted } from "~/server/db/helpers";
import * as databaseHelpers from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import {
  suggestionTable,
  expense,
  financialTransaction,
  financialTransactionAllocation,
  spendingCategory,
  sourceOccurrence,
} from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { answering } from "~/server/domains/transaction-import/repo/statement-decision-port.fixtures";
import * as statementSuggestionsRepo from "~/server/domains/transaction-import/repo/statement-suggestions";
import { labelStatementSuggestions as runStatementLabels } from "~/server/domains/transaction-import/service/statement-suggestion-labels";
import {
  readWorkQueue,
  readRecordWorkQueue,
} from "~/server/domains/work/service/work-queue-read";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import * as automaticRuleRuntime from "~/server/generic/suggestions/repo/automatic-application";
import { matchStatementRules } from "~/server/generic/suggestions/repo/automatic-policy";
import { reviewSuggestion } from "~/server/generic/suggestions/repo/review";
import {
  acceptCleanSuggestions,
  listSuggestionPage,
} from "~/server/generic/suggestions/repo/suggestion-list";
import { buildCrudServices } from "~/server/http/request-context";
import { canonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";
import {
  captureBackgroundQueue,
  drainStoredDerived,
} from "~/server/testing/background-queue";
import { readSuggestionDecisions } from "~/server/testing/suggestion-decisions.fixtures";

import { sourceObservationFrom } from "./source-observation-state";
import {
  getSourceTransactionRecordSummary,
  recordSourceTransactionRecords,
  updateSourceTransactionRecords,
} from "./source-transaction-record";
import { listSourceTransactionRecords } from "./source-transaction-record.fixtures";
import { prepareStatementSpending } from "./statement-spending";
import { previewStatementSuggestion } from "./statement-suggestion-preview";
import {
  buildChargeProposals,
  generateStatementSuggestionPage,
  generateStatementHoldVoidPage,
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
  // These journeys supply supported business identity at the stored-answer seam.
  // DecisionPort answers only the closed-set statement questions.
  const rows = await getDb(db)
    .select({ judgment: suggestionTable.judgment, data: suggestionTable.data })
    .from(suggestionTable)
    .where(
      sql`${suggestionTable.family} = ${suggestionFamily.enum.statement_transaction} AND ${suggestionTable.active} AND ${suggestionTable.status} = ${suggestionStatus.enum.pending}`,
    );
  for (const row of rows) {
    const judgment = statementTransactionJudgment.parse(row.judgment);
    if (!judgment.create) continue;
    const identityInput = statementMerchantIdentityInput(judgment.create);
    if (!identityInput) continue;
    const value = {
      name:
        judgment.create.merchant ??
        judgment.create.rawDescription ??
        "Synthetic business",
      confidence: "high",
      counterparty: "business",
    };
    const supportInput = statementMerchantSupportInput(identityInput, value);
    await statementSuggestionsRepo.recordStatementAnswers(db, {
      charge: z
        .object({ source: z.string(), chargeKey: z.string() })
        .parse(row.data),
      answers: {
        candidates: {},
        merchant: {
          identity: {
            value,
            input: identityInput,
            versions: {
              "merchant-identity": STATEMENT_ANSWER_VERSIONS.merchantIdentity,
            },
            models: ["synthetic"],
          },
          support: supportInput
            ? {
                value: true,
                input: supportInput,
                versions: {
                  "merchant-identity-support":
                    STATEMENT_ANSWER_VERSIONS.merchantSupport,
                },
                models: ["synthetic"],
              }
            : null,
        },
      },
    });
  }
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

const card = async (ctx: Ctx, sources: readonly string[] = ["monarch"]) => {
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
    sourceAliases: sources.map((source) => ({
      source,
      alias: "Synthetic Card (...4242)",
      externalAccountId:
        source === "monarch" ? "Synthetic Card (...4242)" : null,
    })),
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
    expectedFingerprint: suggestion.fingerprint ?? suggestion.suggestionId,
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

describe("statement Transaction suggestions", () => {
  const ctx = withTestDb();
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

  it.each(["page", "single"])(
    "fences statement scope when accounts change before %s application",
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
      const applyPage = automaticRuleRuntime.applyAutomaticRulePage;
      const apply = automaticRuleRuntime.applyAutomaticRules;
      let moved = false;
      const move = async (
        db: typeof ctx.db,
        charge: statementSuggestionsRepo.ChargeRef,
      ) => {
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
        // A concurrent unscoped refresh may publish reusable labels for B.
        await regenerate(db, [charge]);
      };
      const page = vi
        .spyOn(automaticRuleRuntime, "applyAutomaticRulePage")
        .mockImplementation(async (...args) => {
          const [selection] = args[1];
          if (phase === "page" && selection) {
            const data = z
              .object({ source: z.string(), chargeKey: z.string() })
              .parse(selection.row.data);
            await move(args[0], data);
          }
          if (phase === "page") return applyPage(...args);
          // A page that falls back leaves each charge to its own review.
          return {
            outcomes: new Map(
              args[1].map((selection) => [selection.row.id, "fallback"]),
            ),
            settled: null,
          };
        });
      const application = vi
        .spyOn(automaticRuleRuntime, "applyAutomaticRules")
        .mockImplementation(async (...args) => {
          if (phase === "single") {
            const [charge] = await getDb(ctx.db)
              .select({ data: suggestionTable.data })
              .from(suggestionTable)
              .where(eq(suggestionTable.id, args[1][0]!));
            await move(
              args[0],
              z
                .object({ source: z.string(), chargeKey: z.string() })
                .parse(charge!.data),
            );
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
        page.mockRestore();
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
      { id: before.id, answers: { candidates: {} }, applicationPending: false },
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
    ).toMatchObject({ unmatchedCharges: 2 });

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

  it("joins a same-source re-export to its occurrence without changing money", async () => {
    await card(ctx);
    const observed = rowInput({ rowPosition: 1 });
    await record(ctx, [observed], { fingerprint: "synthetic-idless-first" });
    await record(ctx, [observed], { fingerprint: "synthetic-idless-second" });
    const retained = (await listSourceTransactionRecords(ctx.db, {})).data;
    expect(retained).toHaveLength(2);
    expect(new Set(retained.map((row) => row.chargeKey)).size).toBe(1);
    await generate(ctx);
    expect(await readPendingStatements(ctx)).toHaveLength(1);
    expect(retained.every((row) => row.transactionId === null)).toBe(true);
    expect(await getDb(ctx.db).select().from(financialTransaction)).toEqual([]);
  });

  // Failure modes: an export without provider IDs keeps every provider row
  // under review as a sibling; an unequal group (a real repeat charge) is
  // superseded anyway.
  it.each([
    ["equal counts", 1, 1, [false]],
    ["an extra ID-less charge", 2, 0, [true, true, true]],
  ])(
    "supersedes exact ID-less twins of provider rows with %s",
    async (_name, idless, superseded, withSiblings) => {
      await card(ctx);
      await record(
        ctx,
        Array.from({ length: idless }, () => rowInput()),
        { fingerprint: "synthetic-idless-export" },
      );
      await record(
        ctx,
        [rowInput({ providerTransactionId: "synthetic-provider-1" })],
        {
          fingerprint: "synthetic-provider-export",
        },
      );
      expect(
        new Set(
          (await listSourceTransactionRecords(ctx.db, {})).data.map(
            (row) => row.chargeKey,
          ),
        ).size,
      ).toBe(idless + 1);
      await generate(ctx);
      const rows = (await listSourceTransactionRecords(ctx.db, {})).data;
      expect(
        rows.filter((row) => row.matchState === "superseded"),
      ).toHaveLength(superseded);
      expect(
        (await readPendingStatements(ctx)).map(
          (suggestion) => suggestion.siblings > 0,
        ),
      ).toEqual(withSiblings);
    },
  );

  it("leaves a cleared twin supersession to the member", async () => {
    await card(ctx);
    await record(ctx, [rowInput()], { fingerprint: "synthetic-idless-export" });
    await record(
      ctx,
      [rowInput({ providerTransactionId: "synthetic-provider-1" })],
      { fingerprint: "synthetic-provider-export" },
    );
    await generate(ctx);
    const superseded = async () =>
      (await listSourceTransactionRecords(ctx.db, {})).data.filter(
        (row) => row.matchState === "superseded",
      );
    const [thin] = await superseded();
    await updateSourceTransactionRecords(
      ctx.db,
      {
        selector: { source: thin!.source, externalIds: [thin!.externalId] },
        data: { supersededByExternalId: null },
      },
      ctx.actor,
    );
    await generate(ctx);
    expect(await superseded()).toEqual([]);
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
    // The create names the new candidate it must reject instead.
    await expect(accept(ctx, suggestion!)).rejects.toThrow(
      /must be rejected before creating: FTX-/,
    );
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
    expect(posted).toMatchObject({ recommended: "supersede", clean: true });
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

  it.each([false, true])(
    "retains answers for high-fanout work across a changed candidate roster: %s",
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

  it.each(["untouched", "conflicted rule", "replaced receipt"] as const)(
    "completes import no-action labels only through their proven prefix (%s)",
    async (mode) => {
      await card(ctx);
      const recorded = await record(ctx, [
        ...(mode === "conflicted rule"
          ? [
              rowInput({
                providerAmount: -11,
                statementDate: "2026-05-01",
                merchant: "Example Ahead Shop",
                rawDescription: "EXAMPLE AHEAD SHOP",
              }),
            ]
          : []),
        rowInput({ rawDescription: "VENMO SYNTHETIC SHARED COST" }),
        rowInput({
          providerAmount: -19,
          rawDescription: "VENMO SYNTHETIC PERSONAL PAYMENT",
        }),
      ]);
      await generate(ctx);
      // The rule-bearing charge leads the page's application order.
      await getDb(ctx.db)
        .update(suggestionTable)
        .set({ createdAt: new Date(Date.UTC(2026, 0, 1)) })
        .where(
          sql`${suggestionTable.active} AND ${suggestionTable.judgment}->${"create"}->>${"rawDescription"} = ${"EXAMPLE AHEAD SHOP"}`,
        );
      const port: DecisionPort = (request) =>
        answering({
          kind: "purchase",
          counterparty: request.state.includes("VENMO") ? "person" : "business",
        })(request);
      const labelPage = (
        after?: NonNullable<
          Parameters<typeof labelStatementSuggestions>[1]
        >["after"],
      ) =>
        labelStatementSuggestions(ctx.db, {
          port,
          scope: { importId: recorded.batchId },
          after,
        });
      const admission = vi.spyOn(automaticRuleRuntime, "applyAutomaticRules");
      const page = automaticRuleRuntime.applyAutomaticRulePage;
      const pageSpy = vi
        .spyOn(automaticRuleRuntime, "applyAutomaticRulePage")
        .mockImplementation(async (...args) => {
          const [, selections, options] = args;
          // The leading rule's page transaction exhausts its replays.
          if (mode === "conflicted rule" && selections.length)
            return {
              outcomes: new Map(
                selections.map((selection) => [
                  selection.row.id,
                  "unfinished" as const,
                ]),
              ),
              settled: null,
            };
          // A concurrent publication replaces the first receipt before the
          // receipt transaction locks it.
          const [first] = options.settle?.ids ?? [];
          if (mode === "replaced receipt" && first)
            await getDb(ctx.db)
              .update(suggestionTable)
              .set({ active: false })
              .where(eq(suggestionTable.id, first));
          return page(...args);
        });
      // Nothing after an unsettled charge completes: every later receipt
      // waits for the inclusive cursor.
      const unsettled = {
        completed: 0,
        next: expect.objectContaining({ inclusive: true }),
      };
      const expected = {
        untouched: { completed: 2, next: null, pending: [] },
        "conflicted rule": {
          ...unsettled,
          pending: [
            "EXAMPLE AHEAD SHOP",
            "VENMO SYNTHETIC PERSONAL PAYMENT",
            "VENMO SYNTHETIC SHARED COST",
          ],
        },
        "replaced receipt": {
          ...unsettled,
          pending: [expect.stringMatching(/^VENMO SYNTHETIC/)],
        },
      }[mode];
      try {
        const outcome = await labelPage();
        expect(admission).toHaveBeenCalledTimes(0);
        expect(outcome).toMatchObject({
          completed: expected.completed,
          failed: [],
          next: expected.next,
        });
        const pending = await statementSuggestionsRepo.suggestionsNeedingLabels(
          ctx.db,
          10,
        );
        expect(
          pending.map((entry) => entry.judgment.create?.rawDescription).sort(),
        ).toEqual(expected.pending);
        expect(pending.every((entry) => entry.applicationPending)).toBe(true);
        expect(await getDb(ctx.db).select().from(financialTransaction)).toEqual(
          [],
        );
        if (mode !== "conflicted rule") return;
        pageSpy.mockRestore();
        expect(await labelPage(outcome.next)).toMatchObject({
          completed: 3,
          failed: [],
          next: null,
        });
        expect(
          await getDb(ctx.db)
            .select({ rawDescription: financialTransaction.rawDescription })
            .from(financialTransaction),
        ).toEqual([{ rawDescription: "EXAMPLE AHEAD SHOP" }]);
      } finally {
        pageSpy.mockRestore();
        admission.mockRestore();
      }
    },
  );

  const shop = (prefix: string, index: number, account?: string) =>
    rowInput({
      ...(account && { accountDescriptor: account }),
      providerAmount: -(11 + index * 7),
      statementDate: new Date(Date.UTC(2026, 4, 1 + index * 3))
        .toISOString()
        .slice(0, 10),
      merchant: `${prefix} Shop ${index}`,
      rawDescription: `${prefix.toUpperCase()} SHOP ${index}`,
    });

  it("applies import label and retained-label generation creates within their statement budget", async () => {
    await card(ctx);
    const recorded = await record(
      ctx,
      Array.from({ length: 32 }, (_, index) =>
        shop(`Example ${String(index).padStart(3, "0")}`, index),
      ),
    );
    await generate(ctx);
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "background" });
    const outcome = await expectStatementBudget(
      () =>
        labelStatementSuggestions(ctx.db, {
          port: answering({ kind: "purchase", counterparty: "business" }),
          runId,
          scope: { importId: recorded.batchId },
        }),
      { statements: 130, parameters: 700 },
    );
    expect(outcome).toMatchObject({ completed: 32, failed: [], next: null });
    expect(
      await getDb(ctx.db)
        .select()
        .from(financialTransaction)
        .where(notDeleted(financialTransaction)),
    ).toHaveLength(32);
    const retained = await record(
      ctx,
      Array.from({ length: 32 }, (_, index) =>
        shop(`Other ${String(index).padStart(3, "0")}`, index),
      ),
      { fingerprint: "synthetic-retained-generation-labels" },
    );
    await generate(ctx);
    await labelStatementSuggestions(ctx.db, {
      port: answering({ kind: "purchase", counterparty: "business" }),
      runId,
    });
    const replay = () =>
      generateStatementSuggestionPage(ctx.db, {
        servicesFor: buildCrudServices,
        runId,
        after: null,
        scope: { importId: retained.batchId },
      });
    expect(
      await expectStatementBudget(replay, { statements: 150, parameters: 700 }),
    ).toMatchObject({ processed: 32, failed: [] });
    await replay();
    expect(
      await getDb(ctx.db)
        .select()
        .from(financialTransaction)
        .where(notDeleted(financialTransaction)),
    ).toHaveLength(64);
  });

  it("writes the same ledger, audit and Feedback on the page and single paths", async () => {
    const first = await card(ctx);
    const second = await createRepoIdentity(ctx, "financialAccount", {
      name: "Synthetic Second Card",
      ledgerPartyId: first.ledgerPartyId,
      identity: { kind: "credit_card", network: "visa" },
      sourceAliases: [
        {
          source: "monarch",
          alias: "Synthetic Second Card (...5151)",
          externalAccountId: "Synthetic Second Card (...5151)",
        },
      ],
    });
    const uuid =
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
    // Each run names its own merchants and account; everything else,
    // including Vendor creation, must match after masking identities.
    type Snapshot = z.infer<typeof jsonSnapshot>;
    const normalize = (value: Snapshot, key = ""): Snapshot => {
      if (value === null) return value;
      if (
        /(^id|Id|Ids|At|Key|Fingerprint|fingerprint|Refs|shortcode|externalId|cursor)$/.test(
          key,
        ) ||
        ["key", "account", "sourceRef", "decisions"].includes(key)
      )
        return "<masked>";
      if (typeof value === "string")
        return value
          .replace(uuid, "<uuid>")
          .replace(/\b[A-Z]{2,4}-[0-9A-Z]{5}\b/g, "<code>")
          .replace(/alpha|beta/gi, "X")
          .replace(/Synthetic (Second )?Card/g, "Card")
          .replace(/\.\.\.(4242|5151)/g, "...");
      if (Array.isArray(value))
        return value
          .map((item) => normalize(item))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      if (typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([name, item]) => [
            name,
            normalize(item, name),
          ]),
        );
      return value;
    };
    const run = async (
      prefix: string,
      account: string,
      accountId: string,
      single: boolean,
    ) => {
      // A nearby Purchase of one charge's Vendor that another posted charge
      // of a different amount fully settles is a different bank event.
      const vendor = await createRepoIdentity(ctx, "vendor", {
        name: `${prefix} Shop 1`,
      });
      const settled = await createRepoIdentity(ctx, "purchase", {
        vendorId: vendor.output.id,
        date: "2026-05-03",
      });
      await createRepoIdentity(ctx, "expense", {
        purchaseId: settled.output.id,
        name: "Synthetic settled order",
        cost: 30,
        trade: "other",
      });
      await createRepoIdentity(ctx, "financialTransaction", {
        accountId,
        kind: "purchase",
        status: "posted",
        amount: 30,
        postedDate: "2026-05-03",
        allocations: [{ purchaseId: settled.output.id, amount: 30 }],
      });
      const recorded = await record(
        ctx,
        [
          ...Array.from({ length: 4 }, (_, index) =>
            shop(prefix, index, account),
          ),
          // A repeat Vendor within two weeks depends on the first booking.
          ...[2, 7].map((day) =>
            rowInput({
              accountDescriptor: account,
              providerAmount: -(17 + day),
              statementDate: `2026-05-0${day}`,
              merchant: `${prefix} Shop 0`,
              rawDescription: `${prefix.toUpperCase()} SHOP 0 REPEAT ${day}`,
            }),
          ),
        ],
        { fingerprint: `synthetic-differential-${prefix}` },
      );
      await generate(ctx);
      const { rows: clock } = await getDb(ctx.db).execute<{ since: string }>(
        sql`SELECT clock_timestamp()::text AS since`,
      );
      const since = clock[0]!.since;
      const page = automaticRuleRuntime.applyAutomaticRulePage;
      const fallback = vi
        .spyOn(automaticRuleRuntime, "applyAutomaticRulePage")
        .mockImplementation(async (...args) =>
          single
            ? {
                outcomes: new Map(
                  args[1].map((selection) => [selection.row.id, "fallback"]),
                ),
                settled: null,
              }
            : page(...args),
        );
      try {
        // Dependent bookings may settle on a later pass; both paths run until
        // nothing is left to label or apply.
        let completed = 0;
        for (let pass = 0; pass < 4; pass++) {
          const outcome = await labelStatementSuggestions(ctx.db, {
            port: answering({ kind: "purchase", counterparty: "business" }),
            scope: { importId: recorded.batchId },
          });
          expect(outcome.failed).toEqual([]);
          completed += outcome.completed;
          if (!outcome.next && !outcome.completed) break;
        }
        expect(completed).toBe(6);
      } finally {
        fallback.mockRestore();
      }
      const created = async (table: string) =>
        (
          await getDb(ctx.db).execute<{ row: unknown }>(
            sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(table)} t WHERE t."createdAt" >= ${since}::timestamptz`,
          )
        ).rows.map(({ row }) => jsonSnapshot.parse(row));
      const decisions = (await readSuggestionDecisions(ctx.db)).filter(
        (decision) => new Date(decision.createdAt) >= new Date(since),
      );
      return normalize(
        jsonSnapshot.parse({
          transactions: await created("FinancialTransaction"),
          allocations: await created("FinancialTransactionAllocation"),
          purchases: await created("Purchase"),
          expenses: await created("Expense"),
          vendors: await created("Vendor"),
          audit: await created("AuditLog"),
          feedback: decisions,
        }),
      );
    };
    const page = await run(
      "Alpha",
      "Synthetic Card (...4242)",
      first.output.id,
      false,
    );
    const single = await run(
      "Beta",
      "Synthetic Second Card (...5151)",
      second.output.id,
      true,
    );
    expect(page).toMatchObject({
      transactions: expect.arrayContaining([
        expect.objectContaining({ rawDescription: "X SHOP 1" }),
      ]),
    });
    expect(single).toEqual(page);
  });

  async function applyAfterMemberReview(phase: "label" | "generation") {
    await card(ctx);
    const vendor = await createRepoIdentity(ctx, "vendor", {
      name: "Example Shared Vendor",
    });
    await createRepoIdentity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-05-12",
    });
    const recorded = await record(ctx, [
      shop("Example Plain", 0),
      // The same new Vendor, named as name resolution folds it, within 3 days.
      rowInput({
        providerAmount: -20,
        statementDate: "2026-05-05",
        merchant: "Example Twin Shop",
        rawDescription: "EXAMPLE TWIN SHOP 1",
      }),
      rowInput({
        providerAmount: -31,
        statementDate: "2026-05-07",
        merchant: " example twin shop",
        rawDescription: "EXAMPLE TWIN SHOP 2",
      }),
      rowInput({
        providerAmount: -40,
        statementDate: "2026-05-09",
        merchant: "Example Reviewed Shop",
        rawDescription: "EXAMPLE REVIEWED SHOP",
      }),
      // Two payments toward one existing Purchase.
      rowInput({
        providerAmount: -20,
        statementDate: "2026-05-12",
        merchant: "Example Shared Vendor",
        rawDescription: "EXAMPLE SHARED VENDOR 1",
      }),
      rowInput({
        providerAmount: -30,
        statementDate: "2026-05-13",
        merchant: "Example Shared Vendor",
        rawDescription: "EXAMPLE SHARED VENDOR 2",
      }),
    ]);
    await generate(ctx);
    if (phase === "generation")
      await labelStatementSuggestions(ctx.db, {
        port: answering({ kind: "purchase", counterparty: "business" }),
      });
    const page = automaticRuleRuntime.applyAutomaticRulePage;
    const reviewed: string[] = [];
    // Each page transaction's charges, and what it declined to its own review.
    const pageWrites: string[][] = [];
    const declined: string[] = [];
    const descriptionOf = (selection: { row: { judgment: unknown } }) =>
      statementTransactionJudgment.parse(selection.row.judgment).create
        ?.rawDescription ?? "";
    const pageSpy = vi
      .spyOn(automaticRuleRuntime, "applyAutomaticRulePage")
      .mockImplementation(async (...args) => {
        // A member reviews after selection, before the page's locks. Charge-key
        // and receipt ordering can put that charge in a later generation run.
        if (!reviewed.length) {
          const [row] = await getDb(ctx.db)
            .select({ id: suggestionTable.id })
            .from(suggestionTable).where(sql`${suggestionTable.active}
              AND ${suggestionTable.judgment}->${"create"}->>${"rawDescription"} = ${"EXAMPLE REVIEWED SHOP"}`);
          if (!row) throw new Error("Expected the reviewed synthetic charge");
          const selection = (
            await automaticRuleRuntime.selectAutomaticRules(ctx.db, [row.id], {
              settlement: true,
            })
          ).get(row.id);
          if (!selection)
            throw new Error("Expected the reviewed synthetic rule");
          reviewed.push(selection.row.id);
          await reviewSuggestion(ctx.db, kernelCtx(ctx), {
            operationId: "synthetic-member-apply",
            suggestionId: selection.row.id,
            verdict: "correct",
            correction: { present: false },
            intent: "apply",
            expectedFingerprint: selection.review.expectedFingerprint,
            reason: null,
            evidence: null,
            application: selection.review.application,
          });
        }
        const result = await page(...args);
        pageWrites.push(args[1].map(descriptionOf));
        for (const selection of args[1])
          if (result.outcomes.get(selection.row.id) === "fallback")
            declined.push(descriptionOf(selection));
        return result;
      });
    try {
      const outcome =
        phase === "label"
          ? await labelStatementSuggestions(ctx.db, {
              port: answering({ kind: "purchase", counterparty: "business" }),
              scope: { importId: recorded.batchId },
            })
          : await generateStatementSuggestionPage(ctx.db, {
              servicesFor: buildCrudServices,
              runId: null,
              after: null,
              scope: { importId: recorded.batchId },
            });
      expect(outcome).toMatchObject({ failed: [] });
    } finally {
      pageSpy.mockRestore();
    }
    expect(reviewed).toHaveLength(1);
    // The member's application wins; the page declines that charge to its
    // own review, which finds nothing left to apply.
    expect(declined).toContain("EXAMPLE REVIEWED SHOP");
    // Two charges naming one new Vendor depend on each other, so whichever
    // order the page sees them in, they never share one write transaction.
    for (const write of pageWrites)
      expect(
        write.filter((description) => description.startsWith("EXAMPLE TWIN"))
          .length,
      ).toBeLessThanOrEqual(1);
    const transactions = (
      await getDb(ctx.db)
        .select({ rawDescription: financialTransaction.rawDescription })
        .from(financialTransaction)
        .where(notDeleted(financialTransaction))
    ).map((row) => row.rawDescription);
    expect(new Set(transactions).size).toBe(transactions.length);
    expect(transactions).toEqual(
      expect.arrayContaining([
        "EXAMPLE PLAIN SHOP 0",
        "EXAMPLE REVIEWED SHOP",
        expect.stringMatching(/^EXAMPLE TWIN SHOP/),
      ]),
    );
    // Payments near one existing Purchase stay for review.
    expect(transactions.filter((row) => row?.includes("SHARED"))).toEqual([]);
  }

  it.each(["label", "generation"] as const)(
    "applies alone what a member reviewed or the %s page shares",
    applyAfterMemberReview,
  );

  it("recovers a committed generation publication after its retirement check fails once", async () => {
    await card(ctx);
    await record(ctx, [rowInput()]);
    const afterCommit = databaseHelpers.runAfterCommit;
    let interrupted = false;
    const effect = vi
      .spyOn(databaseHelpers, "runAfterCommit")
      .mockImplementation((db, work) =>
        typeof work === "function"
          ? afterCommit(db, async (committed) => {
              if (!interrupted) {
                interrupted = true;
                throw new Error(
                  "Synthetic retirement admission failure after commit",
                );
              }
              return work(committed);
            })
          : afterCommit(db, work),
      );
    try {
      // The batch committed before its effect failed; the one-at-a-time pass
      // finds that publication rather than reporting the charge as failed.
      expect(
        await generateStatementSuggestionPage(ctx.db, {
          servicesFor: buildCrudServices,
          after: null,
          runId: null,
        }),
      ).toMatchObject({ failed: [], published: 0, unchanged: 1 });
      expect(interrupted).toBe(true);
      expect(
        await getDb(ctx.db)
          .select({ id: suggestionTable.id })
          .from(suggestionTable)
          .where(eq(suggestionTable.family, "statement_transaction")),
      ).toHaveLength(1);
      expect(await readPendingStatements(ctx)).toHaveLength(1);
    } finally {
      effect.mockRestore();
    }
  });

  it.each(["generation", "label"] as const)(
    "replays a %s page that stopped between its commit and its copy refresh",
    async (phase) => {
      await card(ctx, ["monarch", "copilot"]);
      const primary = await record(ctx, [
        rowInput({ rawDescription: "EXAMPLE GROCER 0001" }),
      ]);
      await record(
        ctx,
        [rowInput({ statementDate: "2026-05-05", merchant: null })],
        { source: "copilot", fingerprint: "fp-copilot-crash" },
      );
      await generate(ctx);
      const runId = await ensureRun(ctx.db, ctx.actor, {
        purpose: "background",
      });
      if (phase === "generation")
        await labelStatementSuggestions(ctx.db, {
          port: answering({ kind: "purchase", counterparty: "business" }),
          runId,
        });
      const page = (recoverSince: Date | null) =>
        phase === "generation"
          ? generateStatementSuggestionPage(ctx.db, {
              servicesFor: buildCrudServices,
              runId,
              after: null,
              scope: { importId: primary.batchId },
              recoverSince,
            })
          : labelStatementSuggestions(ctx.db, {
              port: answering({ kind: "purchase", counterparty: "business" }),
              runId,
              scope: { importId: primary.batchId },
              recoverSince,
            });
      const copyAdvice = () =>
        getDb(ctx.db)
          .select({
            judgment: suggestionTable.judgment,
            decisions: suggestionTable.decisions,
          })
          .from(suggestionTable)
          .where(
            sql`${suggestionTable.active} AND ${suggestionTable.data}->>${"source"} = ${"copilot"}`,
          );
      const checkpoint = new Date();
      // The process stops after the money commit: no after-commit work runs.
      const afterCommit = vi
        .spyOn(databaseHelpers, "runAfterCommit")
        .mockImplementation(async () => undefined);
      try {
        await page(null);
      } finally {
        afterCommit.mockRestore();
      }
      const [booked] = await getDb(ctx.db).select().from(financialTransaction);
      expect(booked).toBeDefined();
      expect(await copyAdvice()).toEqual([]);
      const applied = await getDb(ctx.db)
        .select({
          id: suggestionTable.id,
          decisions: suggestionTable.decisions,
        })
        .from(suggestionTable)
        .where(eq(suggestionTable.status, "applied"));
      // The replay finds nothing left to apply, re-derives the stopped
      // attempt's refresh from its committed decision and keeps its receipts.
      await page(checkpoint);
      const [copy] = await copyAdvice();
      expect(copy?.judgment).toMatchObject({
        recommended: "attach",
        pairedTransactionId: booked!.id,
      });
      expect(
        await getDb(ctx.db).select().from(financialTransaction),
      ).toHaveLength(1);
      expect(
        await getDb(ctx.db)
          .select({
            id: suggestionTable.id,
            decisions: suggestionTable.decisions,
          })
          .from(suggestionTable)
          .where(eq(suggestionTable.status, "applied")),
      ).toEqual(applied);
    },
  );

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

  it("recognizes earned interest without requiring purchase settlement", async () => {
    await card(ctx);
    const recorded = await record(ctx, [
      rowInput({
        providerAmount: 8.66,
        merchant: "Example Bank",
        rawDescription: "EXAMPLE INTEREST PAID",
        sourceCategory: null,
      }),
    ]);
    await generate(ctx);
    await labelStatementSuggestions(ctx.db, {
      port: answering({ kind: "interest", counterparty: "business" }),
      scope: { importId: recorded.batchId },
    });
    expect(await readPendingStatements(ctx)).toHaveLength(0);
    const transactions = await getDb(ctx.db)
      .select({ kind: financialTransaction.kind })
      .from(financialTransaction);
    expect(transactions).toEqual([{ kind: "interest" }]);
    expect(await getDb(ctx.db).select().from(expense)).toHaveLength(0);
  });

  it("holds checking-side loan payments for pairing and classifies loan credits", async () => {
    const household = await createRepoIdentity(ctx, "ledgerParty", {
      name: "Synthetic household",
      kind: "household",
    });
    for (const [alias, identity] of [
      ["Synthetic Checking", { kind: "bank_account", accountType: "checking" }],
      ["Synthetic Loan", { kind: "loan" }],
    ] as const) {
      await createRepoIdentity(ctx, "financialAccount", {
        name: alias,
        identity,
        ledgerPartyId: household.output.id,
        sourceAliases: [{ source: "monarch", alias, externalAccountId: null }],
      });
    }
    await record(ctx, [
      rowInput({
        accountDescriptor: "Synthetic Checking",
        providerAmount: -500,
        merchant: "Synthetic lender",
        rawDescription: "SYNTHETIC LENDER PAYMENT",
        sourceCategory: "Housing",
      }),
      rowInput({
        accountDescriptor: "Synthetic Loan",
        providerAmount: 500,
        merchant: "Synthetic lender",
        rawDescription: "PAYMENT",
        sourceCategory: "Payment",
      }),
      rowInput({
        accountDescriptor: "Synthetic Loan",
        providerAmount: 3,
        merchant: "Synthetic lender",
        rawDescription: "INTEREST ON ESC",
        sourceCategory: "Other Income",
      }),
      rowInput({
        accountDescriptor: "Synthetic Loan",
        providerAmount: 7,
        merchant: "Synthetic lender",
        rawDescription: "ESCROW REFUND",
        sourceCategory: "Other Income",
      }),
    ]);
    await generate(ctx);
    const rows = await readPendingStatements(ctx);
    expect(
      rows.find((row) => row.rawDescription === "SYNTHETIC LENDER PAYMENT"),
    ).toMatchObject({
      clean: false,
      create: { kind: "account_transfer" },
      reviewReason: expect.stringContaining("transfer pair"),
    });
    expect(rows.find((row) => row.rawDescription === "PAYMENT")).toMatchObject({
      create: { kind: "account_transfer" },
    });
    expect(
      rows.find((row) => row.rawDescription === "INTEREST ON ESC"),
    ).toMatchObject({ create: { kind: "interest" } });
    expect(
      rows.find((row) => row.rawDescription === "ESCROW REFUND"),
    ).toMatchObject({ create: { kind: "income" } });
    expect(await getDb(ctx.db).select().from(expense)).toHaveLength(0);
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
      /changed since review|stale/,
    );
    // Republication, not a scanner, replaces the stale advice; the refused
    // Replaced rows retain compatible answers for later charge publications.
    expect(await generate(ctx)).toBe(1);
    expect(await stateOf(ctx, suggestion!.suggestionId)).toMatchObject({
      active: false,
      status: "superseded",
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

  // Failure modes: accepting one charge leaves a twin's or a different-amount
  // neighbour's suggestion stale, so each refuses at apply until a
  // whole-ledger refresh; the booked Transaction, already claimed by its
  // charge, is recommended as an attach target; the Purchase it booked blocks
  // the next charge as a possible existing Purchase.
  it("refreshes neighbouring suggestions after one is applied", async () => {
    await card(ctx);
    // Provider IDs in one scope prove three distinct bank events.
    await record(ctx, [
      rowInput({
        rawDescription: "EXAMPLE MKTPLACE PMTS",
        providerTransactionId: "synthetic-mktpl-1",
      }),
    ]);
    await record(
      ctx,
      [
        rowInput({
          rawDescription: "EXAMPLE MKTPL*AB12CD34",
          providerTransactionId: "synthetic-mktpl-2",
        }),
      ],
      { fingerprint: "fp-firmed" },
    );
    await record(
      ctx,
      [
        rowInput({
          rawDescription: "EXAMPLE MKTPL*EF56GH78",
          statementDate: "2026-05-05",
          providerAmount: -17.25,
          providerTransactionId: "synthetic-mktpl-3",
        }),
      ],
      { fingerprint: "fp-neighbour" },
    );
    await generate(ctx);
    const byDescription = async (rawDescription: string) =>
      (await readPendingStatements(ctx)).find(
        (row) => row.rawDescription === rawDescription,
      );
    const neighbourBefore = await byDescription("EXAMPLE MKTPL*EF56GH78");
    expect(neighbourBefore).toMatchObject({ candidates: [] });
    await accept(ctx, (await byDescription("EXAMPLE MKTPLACE PMTS"))!);
    for (const rawDescription of [
      "EXAMPLE MKTPL*AB12CD34",
      "EXAMPLE MKTPL*EF56GH78",
    ]) {
      const refreshed = await byDescription(rawDescription);
      expect(refreshed).toMatchObject({
        recommended: "create",
        siblings: 0,
        candidates: expect.arrayContaining([
          expect.objectContaining({
            transactionId: expect.stringMatching(/^FTX-/),
          }),
        ]),
      });
      expect(
        refreshed!.candidates.every((c) => c.contextReason === "claimed"),
      ).toBe(true);
      await accept(
        ctx,
        refreshed!,
        {
          rejectedCandidateIds: refreshed!.candidates.map(
            (candidate) => candidate.transactionId,
          ),
        },
        true,
      );
    }
    expect(await readPendingStatements(ctx)).toEqual([]);
    const { rows } = await getDb(ctx.db).execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM "FinancialTransaction" WHERE "deletedAt" IS NULL`,
    );
    expect(rows[0]!.n).toBe(3);
  });

  it("books one Transaction for a charge several sources exported", async () => {
    const account = await card(ctx, ["monarch", "copilot"]);
    await record(ctx, [rowInput({ rawDescription: "EXAMPLE GROCER 0001" })]);
    await record(
      ctx,
      [rowInput({ statementDate: "2026-05-05", merchant: null })],
      { source: "copilot", fingerprint: "fp-copilot" },
    );
    await generate(ctx);
    const [primary, ...rest] = await readPendingStatements(ctx);
    expect(rest).toEqual([]);
    expect(primary).toMatchObject({ recommended: "create", siblings: 0 });
    await accept(ctx, primary!);
    const [booked] = await getDb(ctx.db).select().from(financialTransaction);
    await createRepoIdentity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-05",
      merchant: "Example Grocer",
      rawDescription: "EXAMPLE GROCER DECOY",
      sourceRefs: [],
    });
    await generate(ctx);
    const [copy] = await readPendingStatements(ctx);
    expect(copy).toMatchObject({
      recommended: "attach",
      clean: true,
      siblings: 0,
      candidates: expect.arrayContaining([
        expect.objectContaining({
          transactionId: expect.stringMatching(/^FTX-/),
        }),
      ]),
    });
    expect(
      copy!.candidates.filter(
        (candidate) => candidate.eligibility !== "context",
      ),
    ).toHaveLength(2);
    const [stored] = await getDb(ctx.db)
      .select({ judgment: suggestionTable.judgment })
      .from(suggestionTable)
      .where(eq(suggestionTable.id, copy!.suggestionId));
    const judgment = statementTransactionJudgment.parse(stored!.judgment);
    // Candidate ranking does not change which Transaction the bank-copy proof names.
    const reversed = {
      ...judgment,
      candidates: [...judgment.candidates].sort(
        (left, right) =>
          Number(left.transactionId === judgment.pairedTransactionId) -
          Number(right.transactionId === judgment.pairedTransactionId),
      ),
    };
    expect(reversed.candidates[0]!.transactionId).not.toBe(
      judgment.pairedTransactionId,
    );
    expect(
      (await prepareStatementSpending(ctx.db, reversed))?.request.transactionId,
    ).toBe(booked!.shortcode);
    await accept(ctx, copy!);
    expect(await readPendingStatements(ctx)).toEqual([]);
    const { rows } = await getDb(ctx.db).execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM "FinancialTransaction" WHERE "deletedAt" IS NULL`,
    );
    expect(rows[0]!.n).toBe(2);
    const accepted = await getDb(ctx.db).execute<{ id: string }>(sql`
      SELECT DISTINCT "acceptedTransactionId" AS id FROM "SourceOccurrence"
      WHERE "acceptedTransactionId" IS NOT NULL
    `);
    expect(accepted.rows).toEqual([{ id: booked!.id }]);
  });

  // Failure mode: pairing by amount alone would fold two real visits into one
  // Transaction once either source booked them.
  it("keeps repeat charges apart and reviews unequal copies", async () => {
    await card(ctx, ["monarch", "copilot"]);
    const visits = [
      { merchant: "Example Cafe", rawDescription: "EXAMPLE CAFE 0001" },
      {
        merchant: "Example Bakery",
        rawDescription: "EXAMPLE BAKERY 0002",
        statementDate: "2026-05-05",
      },
    ];
    await record(
      ctx,
      visits.map((visit) => rowInput(visit)),
    );
    await record(
      ctx,
      visits.map((visit) => rowInput(visit)),
      { source: "copilot", fingerprint: "fp-copilot" },
    );
    await generate(ctx);
    expect(await readPendingStatements(ctx)).toHaveLength(2);
    // Each event's primary must not retire the other's advice on a rerun.
    await generate(ctx);
    expect(await readPendingStatements(ctx)).toHaveLength(2);
    for (const _ of [0, 1]) {
      const [next] = (await readPendingStatements(ctx)).filter(
        (row) => row.recommended === "create",
      );
      await accept(ctx, next!);
    }
    const copies = await readPendingStatements(ctx);
    expect(copies).toHaveLength(2);
    expect(
      new Set(copies.map((copy) => copy.candidates[0]!.transactionId)).size,
    ).toBe(2);
    expect(copies.every((copy) => copy.clean)).toBe(true);
    await record(ctx, [rowInput({ statementDate: "2026-05-06" })], {
      source: "copilot",
      fingerprint: "fp-copilot-extra",
    });
    await generate(ctx);
    expect((await readPendingStatements(ctx)).every((row) => !row.clean)).toBe(
      true,
    );
  });

  // Window boundaries: a primary on day 0, its copy from another source on
  // day 3, and a same-source charge of the same amount `days` later.
  it.each([6, 7, 8])(
    "settles a primary, its copy and an equal charge %i days later by their windows",
    async (days) => {
      await card(ctx, ["monarch", "copilot"]);
      const later = new Date(Date.UTC(2026, 4, 4 + days))
        .toISOString()
        .slice(0, 10);
      const primary = await record(ctx, [
        rowInput({
          merchant: "Example Cafe",
          rawDescription: "EXAMPLE CAFE 0001",
        }),
        rowInput({
          merchant: "Example Bakery",
          rawDescription: "EXAMPLE BAKERY 0002",
          statementDate: later,
        }),
      ]);
      await record(
        ctx,
        [
          rowInput({
            merchant: null,
            rawDescription: "EXAMPLE CAFE 0001",
            statementDate: "2026-05-07",
          }),
        ],
        { source: "copilot", fingerprint: "fp-copilot-window" },
      );
      await generate(ctx);
      const page = automaticRuleRuntime.applyAutomaticRulePage;
      const pageWrites: string[][] = [];
      const spy = vi
        .spyOn(automaticRuleRuntime, "applyAutomaticRulePage")
        .mockImplementation(async (...args) => {
          pageWrites.push(
            args[1].map(
              (selection) =>
                statementTransactionJudgment.parse(selection.row.judgment)
                  .create?.rawDescription ?? "",
            ),
          );
          return page(...args);
        });
      try {
        expect(
          await labelStatementSuggestions(ctx.db, {
            port: answering({ kind: "purchase", counterparty: "business" }),
            scope: { importId: primary.batchId },
          }),
        ).toMatchObject({ failed: [] });
      } finally {
        spy.mockRestore();
      }
      const booked = (
        await getDb(ctx.db)
          .select({ rawDescription: financialTransaction.rawDescription })
          .from(financialTransaction)
          .where(notDeleted(financialTransaction))
      )
        .map((row) => row.rawDescription)
        .sort();
      // Six days puts the later charge within one window of the copy, so no
      // member sees a stable group and every charge waits for review.
      expect(booked).toEqual(
        days === 6 ? [] : ["EXAMPLE BAKERY 0002", "EXAMPLE CAFE 0001"],
      );
      // Equal amounts within the pending-post window never share a write.
      expect(pageWrites.some((write) => write.length > 1)).toBe(days === 8);
    },
  );

  // Failure mode: once one of two same-amount charges is attached, the other
  // has no unmatched sibling left, so a model "same" alone would attach a
  // second real charge onto the transaction that already settles the first.
  it("never recommends an attach to a transaction another charge already settles", async () => {
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
      recommended: "create",
      siblings: 0,
      candidates: [
        expect.objectContaining({
          eligibility: "context",
          contextReason: "claimed",
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
  it.each(["superseded"] as const)(
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
        candidates: [expect.objectContaining({ eligibility: "eligible" })],
      });
    },
  );

  // Failure modes: a category rule alone makes a create bulk-acceptable; a
  // label that disagrees with the rule still leaves it clean.
  it("never cleans a payment with a person, in either direction", async () => {
    await card(ctx);
    await record(ctx, [
      rowInput({
        merchant: "Sample Friend",
        rawDescription: "VENMO FROM SAMPLE FRIEND",
        sourceCategory: "Paychecks",
        providerAmount: 40,
      }),
      rowInput({
        merchant: "Sample Friend",
        rawDescription: "VENMO *SAMPLE FRIEND",
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

  // Failure mode: a person label published before the rail rule kept its
  // stale kind, so applying it refused as changed since review.
  it("republishes an off-rail person label as a business", async () => {
    await card(ctx);
    await record(ctx, [rowInput({ rawDescription: "SQ *SAMPLE PERSON" })]);
    await generate(ctx);
    await label(ctx, answering({ kind: "purchase", counterparty: "business" }));
    await getDb(ctx.db)
      .update(suggestionTable)
      .set({
        judgment: sql`jsonb_set(${suggestionTable.judgment}, '{create,counterparty,label}', '"person"')`,
      })
      .where(eq(suggestionTable.active, true));
    await generate(ctx);
    const [row] = await readPendingStatements(ctx);
    expect(row).toMatchObject({
      create: { counterparty: { label: "business" } },
    });
  });

  it("accepts an unpaired card payment as a non-spending transaction", async () => {
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
      clean: true,
      create: { kind: "credit_card_payment" },
    });
    expect(attach).toMatchObject({ clean: true });
    expect(
      await acceptCleanSuggestions(ctx.db, kernelCtx(ctx), {
        filters: { family: "statement_transaction" },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          suggestionId: payment!.suggestionId,
          ok: true,
          applied: true,
        }),
        expect.objectContaining({
          suggestionId: attach!.suggestionId,
          ok: true,
          applied: true,
        }),
      ]),
    );
    expect(await stateOf(ctx, payment!.suggestionId)).toMatchObject({
      status: "applied",
    });
    expect(
      await getDb(ctx.db)
        .select({ kind: financialTransaction.kind })
        .from(financialTransaction),
    ).toEqual(expect.arrayContaining([{ kind: "credit_card_payment" }]));
    expect(await getDb(ctx.db).select().from(expense)).toHaveLength(1);
  });

  // Failure modes: a cash-out from the member's own balance account is read
  // as income from its provider category; a move between two owners is bulk
  // accepted without its LedgerTransfer.
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
    // Statement generation runs the transfer-pair lookup for every charge.
    await expectStatementBudget(() => generate(ctx), {
      statements: 37,
      parameters: 39,
    });
    await label(
      ctx,
      answering({ kind: "account_transfer", counterparty: "business" }),
    );
    const rows = await readPendingStatements(ctx);
    expect(rows.find((row) => row.merchant === "PayFriend")).toMatchObject({
      clean: true,
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
    const adjustment = rows.find((row) => row.amount < 0)!;
    const [saved] = await getDb(ctx.db)
      .select({ judgment: suggestionTable.judgment })
      .from(suggestionTable)
      .where(eq(suggestionTable.id, adjustment.suggestionId));
    expect(
      matchStatementRules(statementTransactionJudgment.parse(saved!.judgment)),
    ).toHaveLength(1);
  });
});
