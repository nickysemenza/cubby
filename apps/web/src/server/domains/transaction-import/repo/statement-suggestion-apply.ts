import {
  financialTransactionCreateInput,
  type FinancialTransactionUpdateData,
} from "@cubby/schemas/financial-transaction";
import {
  parseShortcodeFor,
  type FinancialTransactionShortcode,
} from "@cubby/schemas/identifiers";
import {
  statementTransactionJudgment,
  type StatementTransactionApplication,
  type StatementTransactionJudgment,
} from "@cubby/schemas/statement-suggestion";
import { suggestionSubjects } from "@cubby/schemas/suggestion";
import { cents } from "@cubby/shared";
import { createLogger } from "@cubby/worker-tracing";
import { eq, inArray, sql } from "drizzle-orm";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { plainDateDaysBetween } from "~/lib/household-date";
import type { Database } from "~/server/db";
import {
  databaseForTransaction,
  runAfterCommit,
  unwrapDb,
  withTransaction,
} from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { uuidArrayParam } from "~/server/db/helpers/query";
import { suggestionTable } from "~/server/db/schema";
import { lockFinancialEvidenceKeys } from "~/server/domains/financial-transaction/repo/financial-evidence";
import {
  lockFinancialTransactionSources,
  financialSourceRefsIncluding,
} from "~/server/domains/financial-transaction/repo/financial-source-evidence";
import {
  previewFinancialSpending,
  commitFinancialSpending,
  commitFinancialSpendings,
  prepareFinancialSpendingCandidates,
  prepareFinancialSpendingPage,
} from "~/server/domains/financial-transaction/repo/financial-spending";
import { nearbyStatementCandidate } from "~/server/domains/financial-transaction/repo/financial-statement-projection";
import {
  createFinancialTransaction,
  createFinancialTransactions,
  updateFinancialTransaction,
} from "~/server/domains/financial-transaction/repo/financial-transaction";
import {
  sourceObservationFrom,
  statementSuggestionSourceHeld,
} from "~/server/domains/transaction-import/repo/source-observation-state";
import { updateSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import {
  prepareStatementSpending,
  prepareStatementSpendingFacts,
} from "~/server/domains/transaction-import/repo/statement-spending";
import {
  buildChargeProposals,
  chargeId,
  chargesOutsideImport,
  type ChargeProposal,
  type ChargeRef,
  pendingChargesNear,
  pendingPostedMatch,
  regenerateChargesAfterCommit,
} from "~/server/domains/transaction-import/repo/statement-suggestions";
import { isMoneyMoveKind } from "~/server/domains/transaction-import/repo/statement-transaction-kind";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { createAppError } from "~/server/errors/app-error";
import type { AutomaticBatchEntry } from "~/server/generic/suggestions/repo/review";
import {
  suggestionStateData,
  type SuggestionStateRow,
  transitionSuggestionStates,
} from "~/server/generic/suggestions/repo/suggestion-state";

import {
  changedStatementBooking,
  changedStatementTerms,
  currentStatementApplication,
  loadStatementApplication,
  statementApplicationProjection,
  statementApplicationSelection,
  statementTransactionPatch,
  withPublishedLabels,
} from "./statement-suggestion-application";

const log = createLogger("statement-suggestions");

const refused = (message: string) =>
  createAppError("CONSTRAINT_VIOLATION", message);
const CORRECTION_REVIEW =
  'Review it with verdict "wrong" and correction {present:true, value:<the full application>}.';

/** Apply revalidates authoritative evidence under its keys, independently of background retirement. */
export async function applyStatementTransactionSuggestion(
  db: Database,
  context: EntityKernelContext,
  state: SuggestionStateRow,
  input: {
    application: StatementTransactionApplication;
    corrected: boolean;
    /** The import whose label page applies this charge. */
    importId?: string;
  },
) {
  const { importId } = input;
  const loaded = await loadStatementApplication(db, state);
  const { subject, published, stored } = loaded;
  const { application } = input;
  if (!input.corrected && application.action !== published.recommended)
    throw refused(
      `Accepting a suggestion as is applies its recommended action; a different choice is a correction. ${CORRECTION_REVIEW}`,
    );
  if (!input.corrected && application.kindOverride)
    throw refused(
      `Changing the kind is a correction to the suggestion. ${CORRECTION_REVIEW}`,
    );
  if (!input.corrected && application.booking)
    throw refused(
      `Changing the booking is a correction to the suggestion. ${CORRECTION_REVIEW}`,
    );

  if (
    published.transferPair &&
    application.action === "create" &&
    published.create &&
    isMoneyMoveKind(published.create.kind)
  ) {
    const { lockTransferPairLegs } =
      await import("~/server/domains/transaction-import/repo/transfer-pair-suggestions");
    await lockTransferPairLegs(db, published.transferPair.key);
  }
  await withTransaction(db, async (tx) => {
    // Source account judgments run later under this same reservation, before occurrence row locks.
    const pairCreate =
      published.transferPair &&
      application.action === "create" &&
      published.create &&
      isMoneyMoveKind(published.create.kind);
    if (!pairCreate) {
      await lockFinancialEvidenceKeys(
        tx,
        "source",
        stored.refs.map((ref) => ref.slice(0, ref.indexOf(":"))),
      );
      const candidateIds = published.candidates.map(
        (candidate) => candidate.transactionId,
      );
      const candidates = candidateIds.length
        ? await unwrapDb(tx).execute<{ shortcode: string }>(sql`
            SELECT shortcode FROM "FinancialTransaction"
            WHERE id = ANY(${uuidArrayParam(candidateIds)})
          `)
        : { rows: [] };
      await lockFinancialTransactionSources(
        tx,
        candidates.rows.map((candidate) =>
          parseShortcodeFor("financialTransaction", candidate.shortcode),
        ),
        stored.refs.map((ref) => {
          const split = ref.indexOf(":");
          return {
            source: ref.slice(0, split),
            externalId: ref.slice(split + 1),
          };
        }),
      );
    }
    await transitionSuggestionStates(
      tx,
      eq(suggestionTable.id, state.id),
      appliedStatementState,
    );
  });

  const charge = { source: subject.source, chargeKey: subject.chargeKey };
  const current = await currentStatementApplication(db, loaded, application);
  const judgment = current.judgment;
  const { accountCode, codeOf, targetId } = await statementApplicationSelection(
    db,
    judgment,
    application,
  );
  if (
    application.action === "create" &&
    published.transferPair?.clean &&
    judgment.transferPair?.clean &&
    !application.kindOverride &&
    published.create &&
    isMoneyMoveKind(published.create.kind)
  ) {
    const { applyTransferPair } =
      await import("~/server/domains/transaction-import/repo/transfer-pair-suggestions");
    await applyTransferPair(db, context, {
      key: judgment.transferPair.key,
      expectedFingerprint: judgment.transferPair.fingerprint,
    });
    return;
  }
  const actor = context.actorContext;
  const claimRows = async () => {
    await updateSourceTransactionRecords(
      db,
      {
        selector: {
          source: charge.source,
          externalIds: current.observations.map((row) => row.externalId),
        },
        data: { accountId: parseShortcodeFor("financialAccount", accountCode) },
      },
      actor,
    );
  };

  let appliedTransactionId: FinancialTransactionShortcode | undefined;
  switch (application.action) {
    case "create":
      appliedTransactionId = await applyCreate(
        db,
        judgment,
        application,
        accountCode,
        {
          claimRows,
          actor,
        },
      );
      break;
    case "attach":
      appliedTransactionId = await applyAttach(
        db,
        judgment,
        application,
        codeOf,
        targetId!,
        {
          claimRows,
          actor,
        },
      );
      break;
    case "supersede":
      appliedTransactionId = await applySupersede(db, current, codeOf, {
        claimRows,
        actor,
      });
      break;
    case "book":
      appliedTransactionId = codeOf(targetId!);
      break;
    case "void":
      await updateFinancialTransaction.read(
        ["id"],
        db,
        codeOf(targetId!),
        { status: "void" },
        actor,
      );
      break;
  }
  if (appliedTransactionId) {
    const spending = await previewFinancialSpending(db, {
      transactionId: appliedTransactionId,
      ...application.booking,
      advice: published.spending?.request.advice ?? null,
    });
    if (spending.status === "deferred") {
      const kind = application.kindOverride ?? judgment.create?.kind;
      if (
        judgment.providerStatus === "posted" &&
        kind &&
        ["purchase", "refund", "fee"].includes(kind)
      )
        throw refused(
          "The matched transaction's kind or status cannot book this spending; correct it first.",
        );
    } else await commitFinancialSpending(db, spending, actor);
  }
  // This write changes the candidates, claims, holds and copies of pending
  // charges near it on the account; refresh them now rather than leaving them
  // to refuse at apply until a whole-ledger pass.
  const target = judgment.candidates.find(
    (candidate) => candidate.transactionId === targetId,
  );
  await refreshStatementNeighbours(
    db,
    [
      {
        charge,
        judgment,
        dates: [
          judgment.statementDate,
          ...[target?.transactionDate, target?.postedDate].filter(
            (date): date is string => Boolean(date),
          ),
        ],
      },
    ],
    importId,
  );
}

/** Applied charges settle their receipt with their state. */
function appliedStatementState(row: SuggestionStateRow) {
  const {
    applicationPending: _pending,
    applicationOrder: _order,
    ...data
  } = suggestionStateData.parse(row.data ?? {});
  return { status: "applied" as const, data };
}

/**
 * These writes change the candidates, claims, holds and copies of pending
 * charges near them on each account; refresh them after commit rather than
 * leaving them to refuse at apply until a whole-ledger pass. An import label
 * page skips charges of its own import, which it rebuilds itself.
 */
async function refreshStatementNeighbours(
  db: Database,
  applied: readonly {
    charge: ChargeRef;
    judgment: StatementTransactionJudgment;
    dates: readonly string[];
  }[],
  importId: string | undefined,
) {
  if (!applied.length) return;
  await runAfterCommit(db, async (committed) => {
    try {
      const own = new Set(applied.map(({ charge }) => chargeId(charge)));
      const accounts = new Map<string, string[]>();
      for (const { judgment, dates } of applied)
        accounts.set(judgment.accountId, [
          ...(accounts.get(judgment.accountId) ?? []),
          ...dates,
        ]);
      const neighbours: ChargeRef[] = applied.flatMap(
        ({ judgment }) => judgment.copies,
      );
      for (const [accountId, dates] of accounts)
        neighbours.push(
          ...(await pendingChargesNear(committed, accountId, dates)),
        );
      const others = [
        ...new Map(
          neighbours
            .filter((other) => !own.has(chargeId(other)))
            .map((other) => [chargeId(other), other]),
        ).values(),
      ];
      await regenerateChargesAfterCommit(
        committed,
        importId
          ? await chargesOutsideImport(committed, importId, others)
          : others,
      );
    } catch (error) {
      // SILENT: advisory refresh only; the apply committed and each
      // neighbour's own accept rechecks evidence, so the next Refresh repairs it.
      log.error("Neighbour suggestion refresh failed", {
        error: scrubErrorMessage(String(error)),
      });
    }
  });
}

// Bound SERIALIZABLE create runs to keep their predicate-lock footprint small.
export const STATEMENT_PAGE_RUN_CREATES = 8;

/**
 * A published create an import page can apply with others: no transfer, hold,
 * copy or live candidate, and spending that settles without booking or books
 * one new aggregate. Anything else keeps its own review.
 */
export function statementBatchCandidate(
  judgment: StatementTransactionJudgment,
) {
  const create = judgment.create;
  if (
    judgment.recommended !== "create" ||
    !create ||
    judgment.reviewReason ||
    judgment.transferPair ||
    judgment.transfer ||
    isMoneyMoveKind(create.kind) ||
    judgment.supersede ||
    judgment.matchedTransactionId ||
    judgment.pairedTransactionId ||
    judgment.candidates.some((candidate) => candidate.eligibility !== "context")
  )
    return false;
  const spending = judgment.spending;
  if (spending?.status === "deferred")
    return !(
      judgment.providerStatus === "posted" &&
      ["purchase", "refund", "fee"].includes(create.kind)
    );
  return spending?.status === "ready" && spending.effect === "create_aggregate";
}

/** Vendor matching folds case and surrounding whitespace, as `resolveNames` does. */
const vendorName = (name: string | null | undefined) =>
  name?.trim().toLowerCase() ?? "";

/** What one create writes that another charge's application can read. */
function statementFootprint(judgment: StatementTransactionJudgment) {
  const create = judgment.create!;
  const spending =
    judgment.spending?.status === "ready" ? judgment.spending : null;
  const merchant = vendorName(create.merchant || create.rawDescription);
  const named = spending ? vendorName(spending.vendorName) : "";
  return {
    accountId: judgment.accountId,
    date: judgment.statementDate,
    create,
    // Booking resolves the merchant and the cleaned name; creating a Vendor
    // stores the cleaned name with the merchant as its alias.
    lookups: [merchant, named].filter(Boolean),
    created: spending && !spending.vendorId ? [named, merchant] : [],
    vendor: spending
      ? (spending.vendorId ?? (named ? `name:${named}` : null))
      : null,
    category: spending?.spendingCategoryId ?? null,
    purchaseId: spending?.purchaseId ?? null,
  };
}
type StatementFootprint = ReturnType<typeof statementFootprint>;

const daysApart = (left: string, right: string) =>
  Math.abs(plainDateDaysBetween(left, right));

/**
 * Whether applying `earlier` could change what applying `later` writes: its
 * Transaction is a nearby candidate, copy or hold of the later charge, or
 * their bookings share a Purchase, a Vendor's nearby spending or category
 * history, or a Vendor name one of them creates.
 */
function footprintAffects(
  earlier: StatementFootprint,
  later: StatementFootprint,
) {
  if (earlier.accountId === later.accountId) {
    const transaction = {
      amount: earlier.create.amount,
      transactionDate: earlier.create.transactionDate,
      postedDate: earlier.create.postedDate,
      status: earlier.create.status,
      rawDescription: earlier.create.rawDescription,
      merchant: earlier.create.merchant,
    };
    if (
      nearbyStatementCandidate(
        transaction,
        {
          amount: later.create.amount,
          date: later.date,
          description: later.create.rawDescription,
          merchant: later.create.merchant,
        },
        { sameAmountMatches: true, suggestionPolicy: true },
      ) ||
      // Copies pair within a pending-post window; holds settle within it.
      (cents(earlier.create.amount) === cents(later.create.amount) &&
        daysApart(earlier.date, later.date) <= STATEMENT_NEIGHBOUR_DAYS) ||
      (earlier.create.status !== "posted" &&
        later.create.status === "posted" &&
        pendingPostedMatch(
          { amount: earlier.create.amount, date: earlier.date },
          { amount: later.create.amount, date: later.date },
        ))
    )
      return true;
  }
  if (earlier.purchaseId && earlier.purchaseId === later.purchaseId)
    return true;
  // Booking reads the Vendor's Purchases within two weeks as candidates and
  // all of its category history.
  if (
    earlier.vendor &&
    earlier.vendor === later.vendor &&
    (daysApart(earlier.date, later.date) <= 14 ||
      earlier.category !== later.category)
  )
    return true;
  // Booking refuses a lookup name a new Vendor's name or alias contains or
  // is contained by, as name resolution's stored arms match.
  return earlier.created.some((created) =>
    later.lookups.some(
      (lookup) =>
        created.includes(lookup) ||
        (created.length >= 3 && lookup.includes(created)),
    ),
  );
}

/** Pending-post window shared with neighbour refresh. */
const STATEMENT_NEIGHBOUR_DAYS = 7;

/**
 * The statement family's page application: every as-is create the page can
 * take is rechecked and written together under one set of locks, in the same
 * order and with the same outcome as one review each. An entry that is not a
 * batch candidate, moved since publication, or whose footprint meets an
 * earlier entry's falls back before anything is written, so its own review
 * still runs after this page in page order.
 */
export async function applyStatementTransactionSuggestions(
  db: Database,
  context: EntityKernelContext,
  entries: readonly AutomaticBatchEntry[],
  options: { importId?: string },
): Promise<("applied" | "fallback")[]> {
  const results: ("applied" | "fallback")[] = entries.map(() => "fallback");
  if (!entries.length) return results;
  const held = new Set(
    (
      await unwrapDb(db).execute<{ id: string; held: boolean }>(
        sql`SELECT s.id, ${statementSuggestionSourceHeld("s")} AS held FROM "Suggestion" s WHERE s.id = ANY(${uuidArrayParam(entries.map((entry) => entry.state.id))})`,
        "objects",
      )
    ).flatMap((row) => (row.held ? [row.id] : [])),
  );
  const published = entries.map((entry) => {
    const judgment = statementTransactionJudgment.safeParse(
      entry.prediction.judgment,
    );
    return judgment.success ? judgment.data : null;
  });
  const footprints: StatementFootprint[] = [];
  const planned: {
    index: number;
    charge: ChargeRef;
    published: StatementTransactionJudgment;
    refs: string[];
  }[] = [];
  for (const [index, entry] of entries.entries()) {
    const judgment = published[index];
    if (!judgment?.create) continue;
    const footprint = statementFootprint(judgment);
    // An entry that falls back still applies later in page order, so every
    // earlier entry's footprint counts, in both directions.
    const overlaps = footprints.some(
      (earlier) =>
        footprintAffects(earlier, footprint) ||
        footprintAffects(footprint, earlier),
    );
    footprints.push(footprint);
    const { application } = entry.input;
    if (
      overlaps ||
      held.has(entry.state.id) ||
      entry.input.correction.present ||
      application?.kind !== "statement_transaction" ||
      application.action !== judgment.recommended ||
      application.kindOverride ||
      application.booking ||
      application.transactionId ||
      application.fields.length ||
      application.rejectedCandidateIds.length ||
      !statementBatchCandidate(judgment)
    )
      continue;
    const subject = suggestionSubjects.statement_transaction.parse(
      entry.prediction.subject,
    );
    planned.push({
      index,
      charge: { source: subject.source, chargeKey: subject.chargeKey },
      published: judgment,
      refs: statementApplicationProjection.parse(entry.state.data).refs,
    });
  }
  if (!planned.length) return results;
  const actor = context.actorContext;
  await withTransaction(db, async (tx) => {
    const txDb = databaseForTransaction(tx);
    // The single review's locks, across the page and sorted per namespace.
    const refs = planned.flatMap(({ refs }) => refs);
    await lockFinancialEvidenceKeys(
      tx,
      "source",
      refs.map((ref) => ref.slice(0, ref.indexOf(":"))),
    );
    // Candidates are all context; their sources still precede occurrences.
    const candidateIds = planned.flatMap(({ published }) =>
      published.candidates.map((candidate) => candidate.transactionId),
    );
    const candidates = candidateIds.length
      ? await unwrapDb(tx).execute<{ shortcode: string }>(sql`
          SELECT shortcode FROM "FinancialTransaction"
          WHERE id = ANY(${uuidArrayParam(candidateIds)})
        `)
      : { rows: [] };
    await lockFinancialTransactionSources(
      tx,
      candidates.rows.map((candidate) =>
        parseShortcodeFor("financialTransaction", candidate.shortcode),
      ),
      refs.map((ref) => {
        const split = ref.indexOf(":");
        return {
          source: ref.slice(0, split),
          externalId: ref.slice(split + 1),
        };
      }),
    );
    // One rebuild and spending page for the whole set replace each review's
    // rebuild; a charge that moved keeps its own review and its refusal.
    const rebuilt = new Map(
      (
        await buildChargeProposals(
          txDb,
          planned.map(({ charge }) => charge),
        )
      ).map((proposal) => [chargeId(proposal.charge), proposal]),
    );
    const current = planned.flatMap((entry) => {
      const proposal = rebuilt.get(chargeId(entry.charge));
      if (!proposal || proposal.judgment.reviewReason) return [];
      const judgment = withPublishedLabels(proposal.judgment, entry.published);
      if (
        changedStatementTerms(entry.published, judgment, "create", null)
          .length ||
        !statementBatchCandidate({
          ...judgment,
          spending: entry.published.spending,
        })
      )
        return [];
      return [{ ...entry, proposal, judgment }];
    });
    const page = current.length
      ? await prepareStatementSpendingFacts(
          txDb,
          current.map(({ judgment }) => judgment),
        )
      : undefined;
    const ready: (typeof current)[number][] = [];
    for (const entry of current) {
      const spending = entry.published.spending!;
      const replanned = await prepareStatementSpending(
        txDb,
        { ...entry.judgment, recommended: "create" },
        spending.request.advice ?? null,
        page,
      );
      // A deferred plan must still defer; a ready one must book as reviewed.
      if (
        spending.status === "deferred"
          ? replanned?.status !== "deferred"
          : changedStatementBooking(spending, replanned).length
      )
        continue;
      ready.push(entry);
    }
    if (!ready.length) return;
    const accounts = new Map(
      (
        await unwrapDb(tx).execute<{ id: string; shortcode: string }>(
          sql`SELECT id, shortcode FROM "FinancialAccount" WHERE id = ANY(${uuidArrayParam([...new Set(ready.map(({ judgment }) => judgment.accountId))])}) AND ${notDeleted("FinancialAccount")}`,
          "objects",
        )
      ).map((row) => [String(row.id), row.shortcode]),
    );
    const applied = ready.filter(({ judgment }) =>
      accounts.has(judgment.accountId),
    );
    if (!applied.length) return;
    await transitionSuggestionStates(
      tx,
      inArray(
        suggestionTable.id,
        applied.map(({ index }) => entries[index]!.state.id),
      ),
      appliedStatementState,
    );
    // Claims: one write per source and account instead of one per charge.
    const claims = new Map<
      string,
      { source: string; accountId: string; externalIds: string[] }
    >();
    for (const { charge, judgment, proposal } of applied) {
      const accountCode = accounts.get(judgment.accountId)!;
      const key = JSON.stringify([charge.source, accountCode]);
      const claim = claims.get(key) ?? {
        source: charge.source,
        accountId: accountCode,
        externalIds: [],
      };
      claim.externalIds.push(
        ...proposal.observations.map((row) => row.externalId),
      );
      claims.set(key, claim);
    }
    for (const claim of claims.values())
      await updateSourceTransactionRecords(
        txDb,
        {
          selector: { source: claim.source, externalIds: claim.externalIds },
          data: {
            accountId: parseShortcodeFor("financialAccount", claim.accountId),
          },
        },
        actor,
      );
    const created = await createFinancialTransactions(
      tx,
      applied.map(({ judgment }) => {
        const create = judgment.create!;
        return financialTransactionCreateInput.parse({
          accountId: accounts.get(judgment.accountId)!,
          purchaseId: null,
          kind: create.kind,
          status: create.status,
          amount: create.amount,
          transactionDate: create.transactionDate,
          postedDate: create.postedDate,
          merchant: create.merchant,
          rawDescription: create.rawDescription,
          sourceCategory: create.sourceCategory,
          sourceRefs: [create.sourceRef],
          notes: create.notes,
        });
      }),
      actor,
    );
    const codes = new Map(
      (
        await unwrapDb(tx).execute<{ id: string; shortcode: string }>(
          sql`SELECT id, shortcode FROM "FinancialTransaction" WHERE id = ANY(${uuidArrayParam(created)})`,
          "objects",
        )
      ).map((row) => [String(row.id), row.shortcode]),
    );
    // One read-only page serves every new charge's preview before the commit
    // takes its locks and prepares its own.
    const createdPage = await prepareFinancialSpendingPage(txDb, {
      accountIds: [],
      transactionIds: created,
      sources: [],
    });
    await prepareFinancialSpendingCandidates(txDb, createdPage);
    const plans = [];
    for (const [position, { judgment, published }] of applied.entries()) {
      const transactionId = parseShortcodeFor(
        "financialTransaction",
        codes.get(created[position]!)!,
      );
      const plan = await previewFinancialSpending(
        txDb,
        { transactionId, advice: published.spending?.request.advice ?? null },
        undefined,
        createdPage,
      );
      if (plan.status === "deferred") {
        if (
          judgment.providerStatus === "posted" &&
          ["purchase", "refund", "fee"].includes(judgment.create!.kind)
        )
          throw refused(
            "The matched transaction's kind or status cannot book this spending; correct it first.",
          );
        continue;
      }
      plans.push({ plan, transactionId });
    }
    await commitFinancialSpendings(txDb, plans, actor);
    for (const { index } of applied) results[index] = "applied";
    await refreshStatementNeighbours(
      txDb,
      applied.map(({ charge, judgment }) => ({
        charge,
        judgment,
        dates: [judgment.statementDate],
      })),
      options.importId,
    );
  });
  return results;
}

type Effects = {
  claimRows: () => Promise<void>;
  actor: EntityKernelContext["actorContext"];
};

async function applyCreate(
  db: Database,
  judgment: StatementTransactionJudgment,
  application: StatementTransactionApplication,
  accountCode: string,
  effects: Effects,
) {
  const create = judgment.create!;
  await effects.claimRows();
  const created = await createFinancialTransaction.read(
    ["id"],
    db,
    financialTransactionCreateInput.parse({
      accountId: accountCode,
      purchaseId: null,
      kind: application.kindOverride ?? create.kind,
      status: create.status,
      amount: create.amount,
      transactionDate: create.transactionDate,
      postedDate: create.postedDate,
      merchant: create.merchant,
      rawDescription: create.rawDescription,
      sourceCategory: create.sourceCategory,
      sourceRefs: [create.sourceRef],
      notes: create.notes,
    }),
    effects.actor,
  );
  return parseShortcodeFor("financialTransaction", created.output.id);
}

async function applyAttach(
  db: Database,
  judgment: StatementTransactionJudgment,
  application: StatementTransactionApplication,
  codeOf: (id: string) => FinancialTransactionShortcode,
  targetId: string,
  effects: Effects,
) {
  const create = judgment.create!;
  const data: FinancialTransactionUpdateData = {
    sourceRefs: await financialSourceRefsIncluding(
      db,
      targetId,
      create.sourceRef,
    ),
    ...statementTransactionPatch(judgment, application),
  };
  await effects.claimRows();
  await updateFinancialTransaction.read(
    ["id"],
    db,
    codeOf(targetId),
    data,
    effects.actor,
  );
  return codeOf(targetId);
}

async function applySupersede(
  db: Database,
  proposal: ChargeProposal,
  codeOf: (id: string) => FinancialTransactionShortcode,
  effects: Effects,
) {
  const { judgment } = proposal;
  const supersede = judgment.supersede!;
  const create = judgment.create!;
  const pendingRows = await unwrapDb(db).execute<{
    source: string;
    externalId: string;
  }>(
    sql`
    SELECT source, "externalId" FROM ${sourceObservationFrom}
    WHERE id = ANY(${uuidArrayParam(supersede.pendingRowIds)}) AND ${notDeleted("SourceTransactionRecord")}
  `,
    "objects",
  );
  await effects.claimRows();
  for (const source of new Set(pendingRows.map((row) => row.source)))
    await updateSourceTransactionRecords(
      db,
      {
        selector: {
          source,
          externalIds: pendingRows
            .filter((row) => row.source === source)
            .map((row) => row.externalId),
        },
        data: { supersededByExternalId: proposal.canonical.externalId },
      },
      effects.actor,
    );
  const transactionId = supersede.pendingTransactionId;
  await updateFinancialTransaction.read(
    ["id"],
    db,
    codeOf(transactionId),
    {
      sourceRefs: await financialSourceRefsIncluding(
        db,
        transactionId,
        create.sourceRef,
      ),
      ...statementTransactionPatch(judgment, {
        action: "supersede",
        fields: [],
      }),
    },
    effects.actor,
  );
  return codeOf(transactionId);
}
