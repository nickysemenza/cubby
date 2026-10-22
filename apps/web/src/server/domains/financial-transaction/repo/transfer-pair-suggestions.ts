import { suggestionStatus } from "@cubby/schemas/ai";
import {
  assessmentFamily,
  type assessmentReviewInput,
  assessmentSubjects,
  type AssessmentProducer,
} from "@cubby/schemas/assessment";
import {
  type FinancialStatementImportRow,
  type FinancialTransactionKind,
  financialTransactionCreateInput,
  financialTransactionKind,
  financialTransactionSettlementViolation,
  financialTransactionStatus,
} from "@cubby/schemas/financial-transaction";
import { financialTransactionProviderStatus } from "@cubby/schemas/financial-transaction-fields";
import type { FinancialTransactionSourceRef } from "@cubby/schemas/financial-transaction-fields";
import {
  parseShortcodeFor,
  type FinancialTransactionShortcode,
} from "@cubby/schemas/identifiers";
import type { RunStepError } from "@cubby/schemas/run-step";
import {
  transferPairJudgment,
  type StatementTransferPairRef,
  type TransferPairBlocker,
  type TransferPairJudgment,
  type TransferPairLeg,
  type TransferPairMovementLabel,
} from "@cubby/schemas/transfer-pair-suggestion";
import { cents } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { type SQL, and, eq, inArray, sql } from "drizzle-orm";
import { chunk, uniq, uniqBy } from "es-toolkit";
import { z } from "zod";

import { forEachConcurrently } from "~/lib/concurrency-limiter";
import { plainDateDaysBetween, shiftPlainDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import {
  databaseForTransaction,
  getDb,
  unwrapDb,
  withTransaction,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { assessment, assessmentState } from "~/server/db/schema";
import { previewFinancialStatementImport } from "~/server/domains/financial-transaction/repo/financial-statement-preview";
import { createFinancialTransaction } from "~/server/domains/financial-transaction/repo/financial-transaction";
import { acceptFinancialTransferPair } from "~/server/domains/financial-transaction/repo/financial-transfer-accept";
import { transferEvidenceStatuses } from "~/server/domains/ledger-transfer/repo";
import {
  CHARGE_STATE,
  chargeKeyOf,
  chargeStateOf,
} from "~/server/domains/statement-import/repo/statement-charge";
import { statementImportMembers } from "~/server/domains/statement-import/repo/statement-import-membership";
import { updateStatementRows } from "~/server/domains/statement-import/repo/statement-row";
import { statementTransactionKind } from "~/server/domains/statement-import/repo/statement-transaction-kind";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { createAppError } from "~/server/errors/app-error";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";
import {
  transitionAssessmentState,
  transitionAssessmentStates,
} from "~/server/generic/assessment/repo/assessment-state";
import { settlementRefsFor } from "~/server/generic/entity-links/repo/entity-external-ids";
import { canonicalJson } from "~/server/lib/canonical-json";
import {
  assertWorkflowEffect,
  isWorkflowInterrupted,
} from "~/server/workflows/runs/execution";
import { runFailureText } from "~/server/workflows/runs/lifecycle";

/** Rule revision stamped on every published pair; bump with any policy change. */
const TRANSFER_PAIR_REVISION = "2026-10-19.1";
const stateData = z.record(z.string(), z.json());
/** Candidates: the opposite leg posted within this many days. */
const CANDIDATE_WINDOW_DAYS = 5;
/** A clean pair's legs are at most this many days apart. */
const CLEAN_GAP_DAYS = 3;
/** Another record of the same money lands within this window (the statement family's nearby rule). */
const OVERLAP_WINDOW_DAYS = 3;
/** Pool reach around the seeds: a candidate's competitors and overlaps included. */
const POOL_WINDOW_DAYS = 2 * CANDIDATE_WINDOW_DAYS;
const PREVIEW_CHUNK = 500;
// Amortize Job dispatch between pages; the byte bound still limits publications.
const TRANSFER_PAIR_GENERATION_PAGE = 128;
const TRANSFER_PAIR_GENERATION_BYTES = 256 * 1024;
const TRANSFER_PAIR_PUBLICATION_CONCURRENCY = 4;

/** Kinds that move money between accounts; they retrieve a leg, never prove it. */
const MONEY_MOVES = new Set<FinancialTransactionKind>([
  "account_transfer",
  "credit_card_payment",
]);
/**
 * Exact provider category values for a cash withdrawal, folded as
 * `statementTransactionKind` folds categories. Provider metadata, not a
 * descriptor reading: it only retrieves a bank leg for a cash-leg offer.
 */
const CASH_WITHDRAWAL_CATEGORIES = new Set([
  "cash atm",
  "atm",
  "atm cash",
  "cash withdrawal",
  "atm withdrawal",
]);
const foldCategory = (category: string) =>
  category
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&|\band\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const refused = (message: string) =>
  createAppError("CONSTRAINT_VIOLATION", message);

type ChargeRef = { source: string; chargeKey: string };
const chargeId = (charge: ChargeRef) => `${charge.source}:${charge.chargeKey}`;

type Account = {
  id: string;
  shortcode: string;
  name: string;
  kind: string;
  owner: { uuid: string; id: string; name: string } | null;
};

/** One record that can be a leg, before it is placed in a pair. */
type LegFacts = {
  key: string;
  origin: "transaction" | "statement";
  account: Account;
  transactionCode: FinancialTransactionShortcode | null;
  charge: ChargeRef | null;
  /** Imports observing a statement leg: two rows of one export are two charges. */
  imports: ReadonlySet<string>;
  amount: number;
  date: string;
  merchant: string | null;
  description: string | null;
  notes: string | null;
  recordedKind: FinancialTransactionKind | null;
  providerCategory: string | null;
  /** The provider-category rule's kind, when a rule chose it. */
  ruleKind: FinancialTransactionKind | null;
  refs: FinancialTransactionSourceRef[];
  /** Same-account transactions a statement leg may already be recorded as. */
  transactionOverlaps: TransferPairLeg["overlaps"];
  seed: boolean;
  cashWithdrawal: boolean;
};

type Pair = {
  judgment: TransferPairJudgment;
  outflowAccountId: string;
  inflowAccountId: string;
};

const dayGap = (a: string, b: string) => Math.abs(plainDateDaysBetween(a, b));

const isSeed = (leg: {
  recordedKind: FinancialTransactionKind | null;
  ruleKind: FinancialTransactionKind | null;
  cashWithdrawal: boolean;
}) =>
  (leg.recordedKind !== null && MONEY_MOVES.has(leg.recordedKind)) ||
  (leg.ruleKind !== null && MONEY_MOVES.has(leg.ruleKind)) ||
  leg.cashWithdrawal;

const categorySignals = (sourceCategory: string | null, amount: number) => {
  const rule = statementTransactionKind({ sourceCategory, amount });
  return {
    ruleKind: rule.kindSource === "rule" ? rule.kind : null,
    cashWithdrawal:
      amount > 0 &&
      sourceCategory !== null &&
      CASH_WITHDRAWAL_CATEGORIES.has(foldCategory(sourceCategory)),
  };
};

// ------------------------------------------------------------------ reads

/** Live accounts; one whose owner is soft-deleted is no leg's account. */
async function loadAccounts(db: Database) {
  const { rows } = await unwrapDb(db).execute<{
    id: string;
    shortcode: string;
    name: string;
    kind: string;
    ownerUuid: string | null;
    ownerCode: string | null;
    ownerName: string | null;
    ownerDeleted: boolean;
  }>(sql`
    SELECT fa.id, fa.shortcode, fa.name, fa.identity->>${"kind"} AS kind,
      lp.id AS "ownerUuid", lp.shortcode AS "ownerCode", lp.name AS "ownerName",
      (fa."ledgerPartyId" IS NOT NULL AND (lp.id IS NULL OR lp."deletedAt" IS NOT NULL)) AS "ownerDeleted"
    FROM "FinancialAccount" fa
    -- includes-deleted: a deleted owner is read to exclude its accounts.
    LEFT JOIN "LedgerParty" lp ON lp.id = fa."ledgerPartyId"
    WHERE fa."deletedAt" IS NULL
  `);
  const accounts = rows
    .filter((row) => !row.ownerDeleted)
    .map((row): Account => ({
      id: String(row.id),
      shortcode: row.shortcode,
      name: row.name,
      kind: row.kind,
      owner:
        row.ownerUuid && row.ownerCode && row.ownerName
          ? {
              uuid: String(row.ownerUuid),
              id: row.ownerCode,
              name: row.ownerName,
            }
          : null,
    }));
  return {
    byId: new Map(accounts.map((account) => [account.id, account])),
    byCode: new Map(accounts.map((account) => [account.shortcode, account])),
    cashOf: (ownerUuid: string) =>
      accounts.filter(
        (account) =>
          account.kind === "cash" && account.owner?.uuid === ownerUuid,
      ),
  };
}
type Accounts = Awaited<ReturnType<typeof loadAccounts>>;

type LegFilter = {
  /** Only legs a money-move or cash-withdrawal signal retrieves. */
  seedOnly?: boolean;
  since?: string | null;
  amountsCents?: readonly number[];
  from?: string;
  to?: string;
  codes?: readonly string[];
  charges?: readonly ChargeRef[];
};

const amountIn = (column: SQL, amounts: readonly number[]) =>
  sql`round(abs(${column}) * 100)::bigint IN (${sql.join(
    amounts.map((amount) => sql`${amount}`),
    sql`, `,
  )})`;

/**
 * Supported observed transactions no LedgerTransfer, Purchase allocation or booked
 * Expense claims: the recorded legs an accept writer would take.
 */
async function loadTransactionLegs(
  db: Database,
  accounts: Accounts,
  filter: LegFilter,
): Promise<LegFacts[]> {
  if (filter.amountsCents?.length === 0 || filter.codes?.length === 0)
    return [];
  if (filter.charges) return [];
  const day = sql`COALESCE(ft."postedDate", ft."transactionDate")`;
  const conditions = [
    ...(filter.seedOnly
      ? [
          sql`(ft.kind IN (${sql.join(
            [...MONEY_MOVES].map((kind) => sql`${kind}`),
            sql`, `,
          )}) OR ft."sourceCategory" IS NOT NULL)`,
        ]
      : []),
    ...(filter.since ? [sql`${day} >= ${filter.since}::date`] : []),
    ...(filter.from ? [sql`${day} >= ${filter.from}::date`] : []),
    ...(filter.to ? [sql`${day} <= ${filter.to}::date`] : []),
    ...(filter.amountsCents
      ? [amountIn(sql`ft.amount`, filter.amountsCents)]
      : []),
    ...(filter.codes
      ? [
          sql`ft.shortcode IN (${sql.join(
            filter.codes.map((code) => sql`${code}`),
            sql`, `,
          )})`,
        ]
      : []),
  ];
  const { rows } = await unwrapDb(db).execute<{
    id: string;
    shortcode: string;
    accountId: string;
    amount: string | number;
    date: string;
    kind: string;
    merchant: string | null;
    rawDescription: string | null;
    sourceCategory: string | null;
    notes: string | null;
  }>(sql`
    SELECT ft.id, ft.shortcode, ft."accountId", ft.amount, ${day}::text AS date,
      ft.kind, ft.merchant, ft."rawDescription", ft."sourceCategory", ft.notes
    FROM "FinancialTransaction" ft
    WHERE ft."deletedAt" IS NULL AND ft.status IN (${sql.join(
      transferEvidenceStatuses.map((status) => sql`${status}`),
      sql`, `,
    )})
      AND ft."ledgerTransferId" IS NULL AND ${day} IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "FinancialTransactionAllocation" fta
        WHERE fta."transactionId" = ft.id AND fta."deletedAt" IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM "Expense" e
        WHERE e."bookingTransactionCode" = ft.shortcode AND e."deletedAt" IS NULL
      )
      ${conditions.length ? sql`AND ${sql.join(conditions, sql` AND `)}` : sql``}
  `);
  const live = rows.flatMap((row) => {
    const account = accounts.byId.get(String(row.accountId));
    const amount = Number(row.amount);
    return account && amount !== 0 ? [{ row, account, amount }] : [];
  });
  const refs = await settlementRefsFor(
    db,
    live.map(({ row }) => String(row.id)),
  );
  return live.flatMap(({ row, account, amount }) => {
    const recordedKind = financialTransactionKind.parse(row.kind);
    const signals = categorySignals(row.sourceCategory, amount);
    const leg: LegFacts = {
      key: `ftx:${row.shortcode}`,
      origin: "transaction",
      account,
      transactionCode: parseShortcodeFor("financialTransaction", row.shortcode),
      charge: null,
      imports: new Set(),
      amount,
      date: row.date,
      merchant: row.merchant,
      description: row.rawDescription,
      notes: row.notes,
      recordedKind,
      providerCategory: row.sourceCategory,
      ...signals,
      refs: refs.get(String(row.id)) ?? [],
      transactionOverlaps: [],
      seed: false,
    };
    leg.seed = isSeed(leg);
    return filter.seedOnly && !leg.seed ? [] : [leg];
  });
}

const observationRow = z.object({
  id: z.string(),
  source: z.string(),
  externalId: z.string(),
  chargeKey: z.string(),
  legacyReference: z.string().nullable(),
  current: z.boolean(),
  withdrawnAt: z.string().nullable(),
  rowPosition: z.coerce.number().nullable(),
  providerTransactionId: z.string().nullable(),
  providerAccountId: z.string().nullable(),
  accountDescriptor: z.string(),
  statementDate: z.string(),
  providerAmount: z.coerce.number(),
  merchant: z.string().nullable(),
  rawDescription: z.string(),
  sourceCategory: z.string().nullable(),
  providerStatus: financialTransactionProviderStatus.nullable(),
  providerNotes: z.string().nullable(),
  accountId: z.string().nullable(),
  importFingerprint: z.string(),
  importIds: z.array(z.string()),
});
type ObservationRow = z.infer<typeof observationRow>;

/** The statement family's charge-to-preview mapping, one row per charge. */
const previewRowFor = (
  charge: ChargeRef,
  row: ObservationRow,
): FinancialStatementImportRow => ({
  key: chargeId(charge),
  source: row.source,
  account: row.accountDescriptor,
  date: row.statementDate,
  amount: row.providerAmount,
  merchant: row.merchant,
  originalStatement: row.rawDescription,
  category: row.sourceCategory,
  notes: row.providerNotes,
  importFingerprint: row.importFingerprint,
  ...(row.rowPosition === null ? {} : { rowPosition: row.rowPosition }),
  providerTransactionId: row.providerTransactionId,
  providerAccountId: row.providerAccountId,
  ...(row.providerStatus ? { providerStatus: row.providerStatus } : {}),
});

/**
 * Current unmatched statement charges whose account resolves as the
 * statement family resolves it. Charge identity is the source's own; two
 * sources' observations of one movement stay two charges, which the overlap
 * rule holds back until statement review converges them.
 */
async function loadStatementLegs(
  db: Database,
  accounts: Accounts,
  filter: LegFilter,
): Promise<LegFacts[]> {
  if (
    filter.amountsCents?.length === 0 ||
    filter.charges?.length === 0 ||
    filter.codes
  )
    return [];
  const conditions = [
    ...(filter.since
      ? [sql`seen."statementDate" >= ${filter.since}::date`]
      : []),
    ...(filter.from ? [sql`seen."statementDate" >= ${filter.from}::date`] : []),
    ...(filter.to ? [sql`seen."statementDate" <= ${filter.to}::date`] : []),
    ...(filter.amountsCents
      ? [amountIn(sql`seen.amount`, filter.amountsCents)]
      : []),
    ...(filter.charges
      ? [
          sql`(seen.source, ${chargeKeyOf("seen")}) IN (${sql.join(
            filter.charges.map(
              (charge) => sql`(${charge.source}, ${charge.chargeKey})`,
            ),
            sql`, `,
          )})`,
        ]
      : []),
  ];
  // A scope selects whole charges; their state still reads every observation.
  const state = conditions.length
    ? chargeStateOf(sql`(r.source, ${chargeKeyOf("r")}) IN (
        SELECT seen.source, ${chargeKeyOf("seen")} FROM "StatementRow" seen
        WHERE seen."deletedAt" IS NULL AND ${sql.join(conditions, sql` AND `)}
      )`)
    : CHARGE_STATE;
  const { rows } = await unwrapDb(db).execute<
    z.input<typeof observationRow>
  >(sql`
    SELECT r.id::text AS id, r.source, r."externalId", ${chargeKeyOf("r")} AS "chargeKey",
      r."legacyReference", r.current, r."withdrawnAt"::text AS "withdrawnAt",
      r."rowPosition", r."providerTransactionId", r."providerAccountId", r."accountDescriptor",
      r."statementDate"::text AS "statementDate", r."providerAmount", r.merchant,
      r."rawDescription", r."sourceCategory", r."providerStatus", r."providerNotes",
      r."accountId"::text AS "accountId", si.fingerprint AS "importFingerprint",
      ARRAY(SELECT m."importId"::text FROM ${statementImportMembers} m WHERE m."statementRowId" = r.id) AS "importIds"
    FROM ${state} cs
    JOIN "StatementRow" r ON r.source = cs.source AND ${chargeKeyOf("r")} = cs."chargeKey"
      AND r."deletedAt" IS NULL
    JOIN "StatementImport" si ON si.id = r."batchId"
    WHERE NOT cs.ignored AND NOT cs.superseded AND cs.shortcode IS NULL
    ORDER BY r."createdAt" DESC, r.id
  `);
  const byCharge = new Map<string, ObservationRow[]>();
  for (const raw of rows) {
    const row = observationRow.parse(raw);
    const key = chargeId(row);
    byCharge.set(key, [...(byCharge.get(key) ?? []), row]);
  }
  const charges = [...byCharge.values()].flatMap((observations) => {
    const canonical = observations.find((row) => row.current);
    if (
      !canonical ||
      canonical.withdrawnAt !== null ||
      canonical.providerAmount === 0
    )
      return [];
    const amount = -canonical.providerAmount;
    const signals = categorySignals(canonical.sourceCategory, amount);
    const seed = isSeed({ recordedKind: null, ...signals });
    if (filter.seedOnly && !seed) return [];
    const charge = { source: canonical.source, chargeKey: canonical.chargeKey };
    return [{ charge, canonical, observations, signals, seed, amount }];
  });

  const legs: LegFacts[] = [];
  for (const page of chunk(charges, PREVIEW_CHUNK)) {
    const preview = await previewFinancialStatementImport(
      db,
      {
        rows: page.map(({ charge, canonical }) =>
          previewRowFor(charge, canonical),
        ),
      },
      {
        candidatePolicy: "suggestion",
        accountHints: new Map(
          page.flatMap(({ charge, observations }) => {
            const stored = observations.find((row) => row.accountId)?.accountId;
            return stored ? [[chargeId(charge), stored] as const] : [];
          }),
        ),
      },
    );
    const byKey = new Map(preview.rows.map((row) => [row.key, row]));
    for (const entry of page) {
      const row = byKey.get(chargeId(entry.charge));
      if (
        !row?.accountId ||
        row.status === "unresolved_account" ||
        row.status === "indistinguishable_duplicate" ||
        row.status === "already_recorded"
      )
        continue;
      const account = accounts.byCode.get(row.accountId);
      if (!account) continue;
      const { canonical, observations, charge } = entry;
      legs.push({
        key: `stmt:${chargeId(charge)}`,
        origin: "statement",
        account,
        transactionCode: null,
        charge,
        imports: new Set(observations.flatMap((obs) => obs.importIds)),
        amount: entry.amount,
        date: canonical.statementDate,
        merchant: canonical.merchant,
        description: canonical.rawDescription,
        notes: canonical.providerNotes,
        recordedKind: null,
        providerCategory: canonical.sourceCategory,
        ...entry.signals,
        // Explicit retained aliases are settlement references; a provider charge
        // key groups observations but never becomes a fabricated source ref.
        refs: uniqBy(
          [
            ...observations.map((obs) => ({
              source: obs.source,
              externalId: obs.externalId,
            })),
            ...observations.flatMap((obs) =>
              obs.legacyReference
                ? [{ source: obs.source, externalId: obs.legacyReference }]
                : [],
            ),
          ],
          (ref) => `${ref.source}\0${ref.externalId}`,
        ).sort((a, b) => a.externalId.localeCompare(b.externalId)),
        // Identity and amount-correction candidates also block a duplicate create.
        transactionOverlaps: row.existingTransactions.map((existing) => ({
          transactionId: existing.id,
          charge: null,
          date:
            existing.postedDate ??
            existing.transactionDate ??
            canonical.statementDate,
          description: existing.rawDescription ?? existing.merchant,
        })),
        seed: entry.seed,
      });
    }
  }
  return legs;
}

// ------------------------------------------------------------- judgment

const explicit = (label: TransferPairMovementLabel | null) =>
  label?.choice === "account_move" && label.confidence === "high";

const legName = (leg: TransferPairLeg) =>
  `${leg.transactionId ?? leg.accountId} (${leg.accountName})`;

/**
 * Derives movement, blockers, clean and apply availability from a pair's
 * facts and labels. Labels can only remove `weak_movement`; every other
 * blocker is structural, so no label makes a pair clean on its own.
 */
function derive(judgment: TransferPairJudgment): TransferPairJudgment {
  const withMovement = (leg: TransferPairLeg): TransferPairLeg => ({
    ...leg,
    movement: explicit(leg.movementLabel) ? "explicit" : "weak",
  });
  const outflow = withMovement(judgment.outflow);
  const inflow = withMovement(judgment.inflow);
  const move =
    !outflow.owner || !inflow.owner
      ? "unowned"
      : outflow.owner.id === inflow.owner.id
        ? "internal"
        : "between_owners";
  const blockers: TransferPairBlocker[] = [];
  const reasons: string[] = [];
  const block = (blocker: TransferPairBlocker, reason: string) => {
    blockers.push(blocker);
    reasons.push(reason);
  };
  if (judgment.competitors.length)
    block(
      "competing_candidates",
      `${judgment.competitors.length} other record(s) could be the opposite leg: ${judgment.competitors
        .map((competitor) => competitor.leg.transactionId ?? competitor.leg.key)
        .join(", ")}.`,
    );
  if (judgment.dateGapDays > CLEAN_GAP_DAYS)
    block(
      "date_gap",
      `The legs are ${judgment.dateGapDays} days apart; a clean pair is at most ${CLEAN_GAP_DAYS}.`,
    );
  for (const leg of [outflow, inflow])
    if (!leg.owner)
      block(
        "owner_missing",
        `Account ${leg.accountId} (${leg.accountName}) has no owner.`,
      );
  if (move === "between_owners")
    block(
      "owners_differ",
      `${outflow.owner!.name} owns ${outflow.accountName} and ${inflow.owner!.name} owns ${inflow.accountName}: accepting records money moving between them.`,
    );
  // A cash leg to be created has no descriptor; its own blocker covers it.
  const weak = [outflow, inflow].filter(
    (leg) => leg.movement === "weak" && leg.origin !== "cash",
  );
  if (weak.length)
    block(
      "weak_movement",
      `No confident descriptor reading says ${weak.map(legName).join(" and ")} moved money between accounts.`,
    );
  const overlapping = [outflow, inflow].filter((leg) => leg.overlaps.length);
  if (overlapping.length)
    block(
      "unresolved_overlap",
      `${overlapping.map(legName).join(" and ")} may also be recorded by another export or transaction; resolve the statement suggestions first.`,
    );
  if (inflow.origin === "cash")
    block(
      "cash_leg_missing",
      `No cash leg is recorded; accepting creates one on ${inflow.accountName} for the full ${judgment.amount}, any ATM fee included.`,
    );
  const unowned = [outflow, inflow].find((leg) => !leg.owner);
  const creatingOverlap = [outflow, inflow].find(
    (leg) => leg.origin === "statement" && leg.overlaps.length,
  );
  return {
    ...judgment,
    outflow,
    inflow,
    move,
    blockers,
    reasons,
    clean: blockers.length === 0,
    apply: unowned
      ? {
          available: false,
          reason: `Set an owner on account ${unowned.accountId} (${unowned.accountName}) before accepting this pair.`,
        }
      : creatingOverlap
        ? {
            available: false,
            reason: `${legName(creatingOverlap)} may already be recorded by another export or transaction; resolve its statement suggestions before creating it.`,
          }
        : { available: true, reason: null },
  };
}

/** The pair with these legs' labels; absent keys keep their label. */
export function labelTransferPair(
  judgment: TransferPairJudgment,
  labels: {
    outflow?: TransferPairMovementLabel | null;
    inflow?: TransferPairMovementLabel | null;
  },
): TransferPairJudgment {
  return transferPairJudgment.parse(
    derive({
      ...judgment,
      outflow: {
        ...judgment.outflow,
        movementLabel:
          labels.outflow === undefined
            ? judgment.outflow.movementLabel
            : labels.outflow,
      },
      inflow: {
        ...judgment.inflow,
        movementLabel:
          labels.inflow === undefined
            ? judgment.inflow.movementLabel
            : labels.inflow,
      },
    }),
  );
}

/** Publication fingerprint: the evidence plus any labels. */
export const fingerprintTransferPair = (judgment: TransferPairJudgment) =>
  sha256Hex(canonicalJson({ revision: TRANSFER_PAIR_REVISION, judgment }));

/** The rule evidence alone: labels and what they derive are stripped. */
export const transferPairEvidenceFingerprint = (
  judgment: TransferPairJudgment,
) =>
  fingerprintTransferPair(
    labelTransferPair(judgment, { outflow: null, inflow: null }),
  );

/** The created transaction's kind: a card on either side makes it a card payment. */
function createdKind(
  leg: LegFacts | null,
  opposite: Account,
  own: Account,
  amount: number,
): FinancialTransactionKind {
  if (leg?.recordedKind) return leg.recordedKind;
  const kind: FinancialTransactionKind =
    own.kind === "credit_card" || opposite.kind === "credit_card"
      ? "credit_card_payment"
      : "account_transfer";
  return financialTransactionSettlementViolation({
    linked: false,
    kind,
    amount,
  })
    ? "account_transfer"
    : kind;
}

function legView(
  leg: LegFacts,
  opposite: Account,
  overlaps: TransferPairLeg["overlaps"],
): TransferPairLeg {
  return {
    key: leg.key,
    origin: leg.origin,
    accountId: parseShortcodeFor("financialAccount", leg.account.shortcode),
    accountName: leg.account.name,
    accountKind: leg.account.kind,
    owner: leg.account.owner
      ? {
          id: parseShortcodeFor("ledgerParty", leg.account.owner.id),
          name: leg.account.owner.name,
        }
      : null,
    transactionId: leg.transactionCode,
    charge: leg.charge,
    amount: leg.amount,
    date: leg.date,
    merchant: leg.merchant,
    description: leg.description,
    kind: createdKind(leg, opposite, leg.account, leg.amount),
    signals: {
      kind: leg.origin === "transaction" ? leg.recordedKind : leg.ruleKind,
      providerCategory: leg.providerCategory,
    },
    movementLabel: null,
    movement: "weak",
    refs: leg.refs,
    overlaps,
  };
}

type Pool = {
  legs: LegFacts[];
  byCents: Map<number, LegFacts[]>;
};

const poolOf = (legs: LegFacts[]): Pool => {
  const unique = uniqBy(legs, (leg) => leg.key);
  const byCents = new Map<number, LegFacts[]>();
  for (const leg of unique) {
    const key = cents(leg.amount);
    byCents.set(key, [...(byCents.get(key) ?? []), leg]);
  }
  return { legs: unique, byCents };
};

/** Equal and opposite, on another account, within the candidate window. */
const candidatesOf = (pool: Pool, leg: LegFacts) =>
  (pool.byCents.get(-cents(leg.amount)) ?? [])
    .filter(
      (other) =>
        other.key !== leg.key &&
        other.account.id !== leg.account.id &&
        dayGap(other.date, leg.date) <= CANDIDATE_WINDOW_DAYS,
    )
    .sort((a, b) => a.key.localeCompare(b.key));

/** Other unresolved records of the same money on the leg's own account. */
function overlapsOf(pool: Pool, leg: LegFacts): TransferPairLeg["overlaps"] {
  const charges = (pool.byCents.get(cents(leg.amount)) ?? [])
    .filter(
      (other) =>
        other.key !== leg.key &&
        other.origin === "statement" &&
        other.account.id === leg.account.id &&
        dayGap(other.date, leg.date) <= OVERLAP_WINDOW_DAYS &&
        // One export speaks one vocabulary: two of its rows are two charges.
        ![...other.imports].some((id) => leg.imports.has(id)),
    )
    .map((other) => ({
      transactionId: null,
      charge: other.charge,
      date: other.date,
      description: other.description,
    }));
  return [...leg.transactionOverlaps, ...charges].sort((a, b) =>
    `${a.transactionId ?? ""}${a.charge ? chargeId(a.charge) : ""}`.localeCompare(
      `${b.transactionId ?? ""}${b.charge ? chargeId(b.charge) : ""}`,
    ),
  );
}

const competitorOf = (
  against: "outflow" | "inflow",
  anchor: LegFacts,
  other: LegFacts,
  opposite: Account,
) => {
  const view = legView(other, opposite, []);
  return {
    against,
    // Labels belong to a leg within its own pair, so a competitor here is weak.
    leg: {
      key: view.key,
      origin: view.origin,
      accountId: view.accountId,
      accountName: view.accountName,
      transactionId: view.transactionId,
      amount: view.amount,
      date: view.date,
      description: view.description,
      movement: "weak" as const,
    },
    dateGapDays: dayGap(anchor.date, other.date),
  };
};

function buildPair(
  pool: Pool,
  outflow: LegFacts,
  inflow: LegFacts | { cash: Account },
): Pair {
  const realInflow = "cash" in inflow ? null : inflow;
  const inflowAccount = "cash" in inflow ? inflow.cash : inflow.account;
  const inflowLeg: TransferPairLeg = realInflow
    ? legView(realInflow, outflow.account, overlapsOf(pool, realInflow))
    : {
        key: `cash:${inflowAccount.shortcode}:${outflow.key}`,
        origin: "cash",
        accountId: parseShortcodeFor(
          "financialAccount",
          inflowAccount.shortcode,
        ),
        accountName: inflowAccount.name,
        accountKind: inflowAccount.kind,
        owner: inflowAccount.owner
          ? {
              id: parseShortcodeFor("ledgerParty", inflowAccount.owner.id),
              name: inflowAccount.owner.name,
            }
          : null,
        transactionId: null,
        charge: null,
        // The full bank amount: an ATM fee is entered on its own, never inferred.
        amount: -outflow.amount,
        date: outflow.date,
        merchant: null,
        description: null,
        kind: "account_transfer",
        signals: { kind: null, providerCategory: null },
        movementLabel: null,
        movement: "weak",
        refs: [],
        overlaps: [],
      };
  const outflowLeg = legView(outflow, inflowAccount, overlapsOf(pool, outflow));
  const competitors = [
    ...candidatesOf(pool, outflow)
      .filter((other) => other.key !== realInflow?.key)
      .map((other) => competitorOf("outflow", outflow, other, outflow.account)),
    ...(realInflow
      ? candidatesOf(pool, realInflow)
          .filter((other) => other.key !== outflow.key)
          .map((other) =>
            competitorOf("inflow", realInflow, other, realInflow.account),
          )
      : []),
  ];
  const date = outflow.date < inflowLeg.date ? outflow.date : inflowLeg.date;
  const judgment = derive({
    key: `${outflowLeg.key}~${inflowLeg.key}`,
    outflow: outflowLeg,
    inflow: inflowLeg,
    amount: Math.abs(outflow.amount),
    date,
    dateGapDays: dayGap(outflow.date, inflowLeg.date),
    move: "unowned",
    competitors,
    blockers: [],
    reasons: [],
    clean: false,
    apply: { available: false, reason: null },
  });
  return {
    judgment: transferPairJudgment.parse(judgment),
    outflowAccountId: outflow.account.id,
    inflowAccountId: inflowAccount.id,
  };
}

/** Which unmatched movements a discovery pass covers; empty covers the ledger. */
export type TransferPairScope = {
  /** Only pairs with a leg on these FinancialAccount UUIDs. */
  accountIds?: readonly string[];
  /** Only pairs a movement dated on or after this day retrieves. */
  since?: string | null;
};

type Seeds =
  | { kind: "ledger"; since: string | null }
  | { kind: "legs"; keys: readonly string[]; seedOnly?: boolean };

const parseLegKey = (key: string) => {
  if (key.startsWith("ftx:")) return { code: key.slice(4) };
  if (key.startsWith("stmt:")) {
    const rest = key.slice(5);
    const split = rest.indexOf(":");
    return split > 0
      ? {
          charge: {
            source: rest.slice(0, split),
            chargeKey: rest.slice(split + 1),
          },
        }
      : null;
  }
  return null;
};

/** Reject non-transfer seeds together; eligible seeds still hydrate independently
 * so preview duplicate checks and complete competing pools remain unchanged. */
async function potentialTransferSeeds(db: Database, keys: readonly string[]) {
  const parsed = keys.map(parseLegKey);
  const codes = parsed.flatMap((leg) => (leg?.code ? [leg.code] : []));
  const charges = parsed.flatMap((leg) => (leg?.charge ? [leg.charge] : []));
  const selections = [
    ...(codes.length
      ? [
          sql`SELECT 'ftx:' || ft.shortcode AS key, ft.amount,
          ft.kind AS "recordedKind", ft."sourceCategory"
        FROM "FinancialTransaction" ft
        WHERE ft."deletedAt" IS NULL AND ft.shortcode IN (${sql.join(
          codes.map((code) => sql`${code}`),
          sql`, `,
        )})`,
        ]
      : []),
    ...(charges.length
      ? [
          sql`SELECT 'stmt:' || r.source || ':' || r."chargeKey" AS key,
          -r."providerAmount" AS amount, NULL::text AS "recordedKind", r."sourceCategory"
        FROM "StatementRow" r
        WHERE r.current AND r."deletedAt" IS NULL
          AND (r.source, r."chargeKey") IN (${sql.join(
            charges.map(
              (charge) => sql`(${charge.source}, ${charge.chargeKey})`,
            ),
            sql`, `,
          )})`,
        ]
      : []),
  ];
  if (!selections.length) return new Set<string>();
  const { rows } = await unwrapDb(db).execute<{
    key: string;
    amount: string | number;
    recordedKind: string | null;
    sourceCategory: string | null;
  }>(sql.join(selections, sql` UNION ALL `));
  return new Set(
    rows.flatMap((row) =>
      isSeed({
        recordedKind: row.recordedKind
          ? financialTransactionKind.parse(row.recordedKind)
          : null,
        ...categorySignals(row.sourceCategory, Number(row.amount)),
      })
        ? [row.key]
        : [],
    ),
  );
}

async function discover(
  db: Database,
  seeds: Seeds,
  loadedAccounts?: Accounts,
): Promise<Pair[]> {
  const accounts = loadedAccounts ?? (await loadAccounts(db));
  let seedLegs: LegFacts[];
  if (seeds.kind === "ledger") {
    const filter = { seedOnly: true, since: seeds.since };
    seedLegs = [
      ...(await loadTransactionLegs(db, accounts, filter)),
      ...(await loadStatementLegs(db, accounts, filter)),
    ];
  } else {
    const parsed = seeds.keys.map(parseLegKey);
    const codes = parsed.flatMap((leg) => (leg?.code ? [leg.code] : []));
    const charges = parsed.flatMap((leg) => (leg?.charge ? [leg.charge] : []));
    seedLegs = [
      ...(codes.length
        ? await loadTransactionLegs(db, accounts, {
            codes,
            seedOnly: seeds.seedOnly,
          })
        : []),
      ...(charges.length
        ? await loadStatementLegs(db, accounts, {
            charges,
            seedOnly: seeds.seedOnly,
          })
        : []),
    ];
  }
  if (!seedLegs.length) return [];
  const dates = seedLegs.map((leg) => leg.date).sort();
  const poolFilter = {
    amountsCents: uniq(seedLegs.map((leg) => Math.abs(cents(leg.amount)))),
    from: shiftPlainDate(dates[0]!, -POOL_WINDOW_DAYS),
    to: shiftPlainDate(dates.at(-1)!, POOL_WINDOW_DAYS),
  };
  const pool = poolOf([
    ...(await loadTransactionLegs(db, accounts, poolFilter)),
    ...(await loadStatementLegs(db, accounts, poolFilter)),
  ]);
  const poolByKey = new Map(pool.legs.map((leg) => [leg.key, leg]));
  const pairs = new Map<string, Pair>();
  for (const seed of seedLegs) {
    const leg = poolByKey.get(seed.key) ?? seed;
    const candidates = candidatesOf(pool, leg);
    for (const candidate of candidates) {
      const [outflow, inflow] =
        leg.amount > 0 ? [leg, candidate] : [candidate, leg];
      const pair = buildPair(pool, outflow, inflow);
      pairs.set(pair.judgment.key, pair);
    }
    // An ATM withdrawal with no recorded cash leg: offer one on the owner's
    // only cash account, for review.
    const owner = leg.account.owner;
    if (
      leg.cashWithdrawal &&
      leg.account.kind !== "cash" &&
      owner &&
      !candidates.some((candidate) => candidate.account.kind === "cash")
    ) {
      const cash = accounts.cashOf(owner.uuid);
      if (cash.length === 1) {
        const pair = buildPair(pool, leg, { cash: cash[0]! });
        pairs.set(pair.judgment.key, pair);
      }
    }
  }
  return [...pairs.values()].sort((a, b) =>
    a.judgment.key.localeCompare(b.judgment.key),
  );
}

const inScope = (pair: Pair, scope: TransferPairScope) =>
  !scope.accountIds?.length ||
  scope.accountIds.includes(pair.outflowAccountId) ||
  scope.accountIds.includes(pair.inflowAccountId);

async function discoverPairs(db: Database, scope: TransferPairScope = {}) {
  const pairs = await discover(db, {
    kind: "ledger",
    since: scope.since ?? null,
  });
  return pairs.filter((pair) => inScope(pair, scope));
}

/** Current rule judgments (no labels) for every unmatched movement in scope. */
export async function discoverTransferPairs(
  db: Database,
  scope: TransferPairScope = {},
): Promise<TransferPairJudgment[]> {
  return (await discoverPairs(db, scope)).map((pair) => pair.judgment);
}

/** One pair's current rule judgment, or null when it is no longer a candidate. */
export async function buildTransferPair(
  db: Database,
  key: string,
): Promise<Pair | null> {
  const legKeys = key.split("~");
  const cash = legKeys[1]?.startsWith("cash:");
  const pairs = await discover(db, {
    kind: "legs",
    keys: cash ? legKeys.slice(0, 1) : legKeys,
  });
  return pairs.find((pair) => pair.judgment.key === key) ?? null;
}

export async function currentTransferPair(
  db: Database,
  key: string,
): Promise<TransferPairJudgment | null> {
  return (await buildTransferPair(db, key))?.judgment ?? null;
}

/** Refresh listed pairs from their legs, retaining the full competing-candidate pool. */
export async function currentTransferPairs(
  db: Database,
  pairKeys: readonly string[],
): Promise<TransferPairJudgment[]> {
  if (!pairKeys.length) return [];
  const wanted = new Set(pairKeys);
  const pairs = await discover(db, {
    kind: "legs",
    keys: uniq(pairKeys.flatMap((key) => key.split("~"))),
  });
  return pairs
    .filter((pair) => wanted.has(pair.judgment.key))
    .map((pair) => pair.judgment);
}

// ------------------------------------------------------------- publication

/** AssessmentState.data of a transfer-pair suggestion. */
export const transferPairStateData = z.object({
  pairKey: z.string(),
  outflowAccountId: z.uuid(),
  inflowAccountId: z.uuid(),
  legKeys: z.array(z.string()),
  /** Settlement refs of the statement legs, `source:externalId`. */
  refs: z.array(z.string()),
  clean: z.boolean(),
  /** The earlier leg's date. */
  date: z.string(),
  lastDate: z.string(),
  amount: z.number(),
  evidenceFingerprint: z.string(),
  needsLabel: z.boolean(),
  /** Model publication committed; dependent statement publications still need to finish. */
  statementRefreshPending: z.boolean().default(false),
});
type TransferPairStateData = z.infer<typeof transferPairStateData>;

/**
 * Rule output a label could change: both legs real, each lacking a label,
 * and an apply that could proceed. A cross-owner, distant or competing pair
 * is labelled too, as review evidence; its other blockers remain.
 */
export const transferPairNeedsLabels = (judgment: TransferPairJudgment) =>
  judgment.apply.available &&
  judgment.inflow.origin !== "cash" &&
  (judgment.outflow.movementLabel === null ||
    judgment.inflow.movementLabel === null);

const isRule = (producer: AssessmentProducer) => producer.kind === "rule";

const pairLock = (key: string) =>
  sql`SELECT pg_advisory_xact_lock(hashtextextended(${`transfer-pair:${key}`}, 0))`;

/** Acquire shared leg locks before any review-state or settlement-ref locks. */
export async function lockTransferPairLegs(db: Database, pairKey: string) {
  for (const key of [...new Set(pairKey.split("~"))].sort())
    await getDb(db).execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`transfer-pair-leg:${key}`}, 0))`,
    );
}

export type TransferPairPublishOutcome =
  | "published"
  | "unchanged"
  | "suppressed";

/**
 * Publish one pair. Its suggestions are locked first, so a review serializes
 * with its replacement: a dismissal holds, unchanged evidence is left alone
 * (keeping labels a rule re-run would drop, and moving the state to the
 * current Run), and anything else is retired before the new one is listed.
 */
export async function publishTransferPair(
  db: Database,
  pair: Pair,
  producer: AssessmentProducer,
): Promise<TransferPairPublishOutcome> {
  const { judgment } = pair;
  const fingerprint = await fingerprintTransferPair(judgment);
  const evidenceFingerprint = await transferPairEvidenceFingerprint(judgment);
  return withTransactionDatabase(db, async (tx) => {
    await assertWorkflowEffect(tx);
    const client = getDb(tx);
    await client.execute(pairLock(judgment.key));
    const { rows: prior } = await client.execute<{
      id: string;
      fingerprint: string | null;
      evidenceFingerprint: string | null;
      suppression: unknown;
      active: boolean;
    }>(sql`
      SELECT id, fingerprint, data->>'evidenceFingerprint' AS "evidenceFingerprint",
        suppression, active FROM "AssessmentState"
      WHERE family = ${assessmentFamily.enum.transfer_pair} AND data->>'pairKey' = ${judgment.key}
      FOR UPDATE
    `);
    if (prior.some((row) => row.suppression !== null)) return "suppressed";
    const same = prior.filter(
      (row) =>
        row.active &&
        (row.fingerprint === fingerprint ||
          (isRule(producer) &&
            row.evidenceFingerprint === evidenceFingerprint)),
    );
    if (same.length) {
      // The state follows the Run that last confirmed it, so a later
      // run-scoped label pass still finds a pair an earlier Run left unlabelled.
      if (producer.runId)
        await transitionAssessmentStates(
          tx,
          inArray(
            assessmentState.id,
            same.map((row) => row.id),
          ),
          { runId: producer.runId },
          { kind: "transfer_pair_reconfirmed" },
        );
      return "unchanged";
    }
    const retire = prior.filter((row) => row.active).map((row) => row.id);
    if (retire.length)
      await transitionAssessmentStates(
        tx,
        inArray(assessmentState.id, retire),
        (row) => ({
          active: false,
          ...(row.status === "pending" && { status: "superseded" }),
        }),
        { kind: "superseded_by_publication" },
      );
    const data: TransferPairStateData = {
      pairKey: judgment.key,
      outflowAccountId: pair.outflowAccountId,
      inflowAccountId: pair.inflowAccountId,
      legKeys: [judgment.outflow.key, judgment.inflow.key],
      refs: [judgment.outflow, judgment.inflow].flatMap((leg) =>
        leg.origin === "statement"
          ? leg.refs.map((ref) => `${ref.source}:${ref.externalId}`)
          : [],
      ),
      clean: judgment.clean,
      date: judgment.date,
      lastDate:
        judgment.outflow.date > judgment.inflow.date
          ? judgment.outflow.date
          : judgment.inflow.date,
      amount: judgment.amount,
      evidenceFingerprint,
      needsLabel: isRule(producer) && transferPairNeedsLabels(judgment),
      statementRefreshPending:
        !isRule(producer) &&
        [judgment.outflow, judgment.inflow].some((leg) => leg.charge !== null),
    };
    await publishAssessment(
      tx,
      {
        publicationKey: `transfer_pair:${judgment.key}:${fingerprint}:${prior.length}`,
        family: "transfer_pair",
        subject: {
          kind: "transfer_pair",
          entity: "financialAccount",
          recordId: pair.outflowAccountId,
          pairKey: judgment.key,
        },
        judgment,
        fingerprint,
        producer,
        evidence: { legs: data.legKeys },
      },
      {
        model: producer.model ?? "rule",
        confidence: judgment.clean ? 1 : 0,
        runId: producer.runId,
        data,
      },
    );
    return "published";
  });
}

/**
 * Resume the dependent statement refresh after a model publication, without
 * another model call. Matching prepares outside the transaction; dependent
 * publications and receipt completion commit together under the effect fence.
 */
export async function refreshTransferPairStatements(
  db: Database,
  pairKey: string,
) {
  const pending = sql`family = ${assessmentFamily.enum.transfer_pair}
    AND data->>'pairKey' = ${pairKey} AND coalesce((data->>'statementRefreshPending')::boolean, false)`;
  const { rows } = await unwrapDb(db).execute(sql`
    SELECT 1 FROM "AssessmentState" WHERE ${pending} LIMIT 1
  `);
  if (!rows.length) return false;
  const charges = pairKey.split("~").flatMap((key) => {
    const parsed = parseLegKey(key);
    return parsed?.charge ? [parsed.charge] : [];
  });
  const {
    buildChargeProposals,
    publishChargeProposal,
    STATEMENT_SUGGESTION_REVISION,
  } =
    await import("~/server/domains/statement-import/repo/statement-suggestions");
  const proposals = await buildChargeProposals(db, charges);
  proposals.sort((a, b) =>
    chargeId(a.charge).localeCompare(chargeId(b.charge)),
  );
  return withTransactionDatabase(db, async (tx) => {
    await assertWorkflowEffect(tx);
    const client = getDb(tx);
    await client.execute(pairLock(pairKey));
    const { rows: receipts } = await client.execute<{ id: string }>(sql`
      SELECT id FROM "AssessmentState" WHERE ${pending} FOR UPDATE
    `);
    if (!receipts.length) return false;
    for (const proposal of proposals)
      await publishChargeProposal(tx, proposal, {
        kind: "rule",
        model: null,
        revision: STATEMENT_SUGGESTION_REVISION,
        runId: null,
        evaluationId: null,
      });
    await transitionAssessmentStates(
      tx,
      inArray(
        assessmentState.id,
        receipts.map((receipt) => receipt.id),
      ),
      (row) => ({
        data: {
          ...stateData.parse(row.data ?? {}),
          statementRefreshPending: false,
        },
      }),
      { kind: "transfer_pair_statement_refreshed" },
    );
    return true;
  });
}

const ruleProducer = (runId: string | null): AssessmentProducer => ({
  kind: "rule",
  model: null,
  revision: TRANSFER_PAIR_REVISION,
  runId,
  evaluationId: null,
});

export const transferPairGenerationCursor = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("discover"),
    afterSeed: z.string().nullable(),
    seed: z.string().nullable(),
    afterPair: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("retire"),
    after: z.object({ createdAt: z.string(), id: z.string() }).nullable(),
  }),
]);
export type TransferPairGenerationCursor = z.infer<
  typeof transferPairGenerationCursor
>;

type TransferPairGenerationPage = {
  found: number;
  published: number;
  unchanged: number;
  retired: number;
  processed: number;
  bytes: number;
  failed: RunStepError[];
  next: TransferPairGenerationCursor | null;
};

/** Raw identities are paged before hydration; each seed still reads its complete competing pool. */
async function nextTransferPairSeeds(
  db: Database,
  input: { after: string | null; limit: number; since: string | null },
) {
  const { rows } = await unwrapDb(db).execute<{ key: string }>(sql`
    SELECT key FROM (
      SELECT 'ftx:' || ft.shortcode AS key FROM "FinancialTransaction" ft
      WHERE ft."deletedAt" IS NULL AND ft.status IN (${sql.join(
        transferEvidenceStatuses.map((status) => sql`${status}`),
        sql`, `,
      )})
        AND ft."ledgerTransferId" IS NULL
        AND COALESCE(ft."postedDate", ft."transactionDate") IS NOT NULL
        AND (ft.kind IN (${sql.join(
          [...MONEY_MOVES].map((kind) => sql`${kind}`),
          sql`, `,
        )}) OR ft."sourceCategory" IS NOT NULL)
        ${input.since ? sql`AND COALESCE(ft."postedDate", ft."transactionDate") >= ${input.since}::date` : sql``}
      UNION
      SELECT 'stmt:' || r.source || ':' || ${chargeKeyOf("r")} AS key
      FROM "StatementRow" r
      WHERE r."deletedAt" IS NULL AND r."sourceCategory" IS NOT NULL
        ${input.since ? sql`AND r."statementDate" >= ${input.since}::date` : sql``}
    ) seeds
    ${input.after ? sql`WHERE key COLLATE "C" > ${input.after} COLLATE "C"` : sql``}
    ORDER BY key COLLATE "C" LIMIT ${input.limit}
  `);
  return rows.map((row) => row.key);
}

/** A pair belongs to the first eligible seed, independent of seed page boundaries. */
const pairSeedKeys = (pair: Pair, scope: TransferPairScope) =>
  [pair.judgment.outflow, pair.judgment.inflow]
    .filter(
      (leg) =>
        leg.origin !== "cash" &&
        (!scope.since || leg.date >= scope.since) &&
        isSeed({
          recordedKind: leg.origin === "transaction" ? leg.signals.kind : null,
          ...categorySignals(leg.signals.providerCategory, leg.amount),
        }),
    )
    .map((leg) => leg.key)
    .sort();

const transferPairFailure = (ref: string, error: unknown): RunStepError => ({
  at: new Date().toISOString(),
  ref,
  message: runFailureText(error instanceof Error ? error : String(error)),
});

/**
 * Count and byte bounds determine the same logical page on replay. One
 * oversized judgment is admitted alone: evidence is never truncated. The
 * cursor carries only a seed/pair position, never the Sweep's whole key set.
 */
export async function generateTransferPairSuggestionsPage(
  db: Database,
  input: {
    runId: string | null;
    scope?: TransferPairScope;
    after?: TransferPairGenerationCursor | null;
    limit?: number;
    maxBytes?: number;
  },
): Promise<TransferPairGenerationPage> {
  const scope = input.scope ?? {};
  const limit = Math.max(
    1,
    Math.min(input.limit ?? TRANSFER_PAIR_GENERATION_PAGE, 128),
  );
  const maxBytes = Math.max(
    1,
    input.maxBytes ?? TRANSFER_PAIR_GENERATION_BYTES,
  );
  const encoder = new TextEncoder();
  const page: TransferPairGenerationPage = {
    found: 0,
    published: 0,
    unchanged: 0,
    retired: 0,
    failed: [],
    processed: 0,
    bytes: 0,
    next: null,
  };
  const after: TransferPairGenerationCursor = input.after ?? {
    kind: "discover",
    afterSeed: null,
    seed: null,
    afterPair: null,
  };
  if (after.kind === "retire") {
    const accountScope = scope.accountIds?.length
      ? sql`AND (s.data->>'outflowAccountId' IN (${sql.join(
          scope.accountIds.map((id) => sql`${id}`),
          sql`, `,
        )})
          OR s.data->>'inflowAccountId' IN (${sql.join(
            scope.accountIds.map((id) => sql`${id}`),
            sql`, `,
          )}))`
      : sql``;
    let sinceScope = sql``;
    if (scope.since) {
      // eslint-disable-next-line cubby/no-raw-enum-literal-in-sql -- date is a TransferPairJudgment JSON property, not an enum value.
      sinceScope = sql`AND s.data->>'date' >= ${scope.since}`;
    }
    // Include inactive history identities so a committed retirement cannot
    // shift this page's counts or continuation when its acknowledgement is lost.
    const { rows } = await unwrapDb(db).execute<{
      id: string;
      createdAt: string;
      pairKey: string;
      active: boolean;
      status: string;
    }>(sql`
      SELECT s.id::text AS id, to_char(s."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "createdAt",
        s.data->>'pairKey' AS "pairKey", s.active, s.status
      FROM "AssessmentState" s
      WHERE s.family = ${assessmentFamily.enum.transfer_pair}
        ${accountScope} ${sinceScope}
        ${after.after ? sql`AND (s."createdAt", s.id) > (${after.after.createdAt}::timestamp, ${after.after.id}::uuid)` : sql``}
      ORDER BY s."createdAt", s.id LIMIT ${limit + 1}
    `);
    const selected: typeof rows = [];
    for (const row of rows.slice(0, limit)) {
      const bytes = encoder.encode(
        JSON.stringify({ id: row.id, pairKey: row.pairKey }),
      ).byteLength;
      if (selected.length && page.bytes + bytes > maxBytes) break;
      selected.push(row);
      page.bytes += bytes;
    }
    page.processed = selected.length;
    const last = selected.at(-1);
    page.next =
      rows.length > selected.length && last
        ? { kind: "retire", after: { createdAt: last.createdAt, id: last.id } }
        : null;
    await forEachConcurrently(
      selected,
      TRANSFER_PAIR_PUBLICATION_CONCURRENCY,
      async (row) => {
        if (!row.active || row.status !== suggestionStatus.enum.pending) return;
        try {
          // Absence is verified now, not inferred from an earlier seed page.
          // Matching preparation holds no publication transaction open.
          const current = await buildTransferPair(db, row.pairKey);
          if (
            current &&
            inScope(current, scope) &&
            pairSeedKeys(current, scope).length
          )
            return;
          const retired = await withTransactionDatabase(db, async (tx) => {
            await assertWorkflowEffect(tx);
            await getDb(tx).execute(pairLock(row.pairKey));
            const retiredRows = await transitionAssessmentStates(
              tx,
              and(
                eq(assessmentState.id, row.id),
                eq(assessmentState.active, true),
                eq(assessmentState.status, "pending"),
              ),
              { active: false, status: "superseded" },
              { kind: "transfer_pair_out_of_scope" },
            );
            return retiredRows.length;
          });
          page.retired += retired;
        } catch (error) {
          if (isWorkflowInterrupted(error)) throw error;
          page.failed.push(
            transferPairFailure(`transfer_pair:${row.pairKey}`, error),
          );
        }
      },
    );
    return page;
  }

  const following = await nextTransferPairSeeds(db, {
    after: after.seed ?? after.afterSeed,
    limit: limit + 1,
    since: scope.since ?? null,
  });
  const seeds = after.seed ? [after.seed, ...following] : following;
  const publications: Pair[] = [];
  let afterSeed = after.afterSeed;
  page.next = { kind: "retire", after: null };
  if (!seeds.length) return page;
  const accounts = await loadAccounts(db);
  const potentialSeeds = await potentialTransferSeeds(
    db,
    seeds.slice(0, limit),
  );
  for (const [index, seed] of seeds.entries()) {
    if (index >= limit || page.found >= limit) {
      page.next = { kind: "discover", afterSeed, seed: null, afterPair: null };
      break;
    }
    page.processed++;
    if (!potentialSeeds.has(seed)) {
      afterSeed = seed;
      continue;
    }
    let pairs: Pair[];
    try {
      pairs = (
        await discover(
          db,
          { kind: "legs", keys: [seed], seedOnly: true },
          accounts,
        )
      ).filter(
        (pair) => inScope(pair, scope) && pairSeedKeys(pair, scope)[0] === seed,
      );
    } catch (error) {
      if (isWorkflowInterrupted(error)) throw error;
      page.failed.push(
        transferPairFailure(`transfer_pair_seed:${seed}`, error),
      );
      afterSeed = seed;
      continue;
    }
    let afterPair = seed === after.seed ? after.afterPair : null;
    let unfinished = false;
    for (const pair of pairs) {
      if (afterPair && pair.judgment.key.localeCompare(afterPair) <= 0)
        continue;
      const bytes = encoder.encode(JSON.stringify(pair.judgment)).byteLength;
      if (
        page.found >= limit ||
        (page.found > 0 && page.bytes + bytes > maxBytes)
      ) {
        page.next = { kind: "discover", afterSeed, seed, afterPair };
        unfinished = true;
        break;
      }
      publications.push(pair);
      page.found++;
      page.bytes += bytes;
      afterPair = pair.judgment.key;
    }
    if (unfinished) break;
    afterSeed = seed;
  }
  await forEachConcurrently(
    publications,
    TRANSFER_PAIR_PUBLICATION_CONCURRENCY,
    async (pair) => {
      try {
        const outcome = await publishTransferPair(
          db,
          pair,
          ruleProducer(input.runId),
        );
        if (outcome === "published") page.published++;
        else page.unchanged++;
      } catch (error) {
        if (isWorkflowInterrupted(error)) throw error;
        page.failed.push(
          transferPairFailure(`transfer_pair:${pair.judgment.key}`, error),
        );
      }
    },
  );
  return page;
}

/**
 * Publish every current pair in scope and retire pending pairs in scope that
 * are no longer candidates. Deterministic and safe to repeat.
 */
export async function generateTransferPairSuggestions(
  db: Database,
  input: { runId: string | null; scope?: TransferPairScope },
): Promise<{
  found: number;
  published: number;
  unchanged: number;
  retired: number;
}> {
  const total = { found: 0, published: 0, unchanged: 0, retired: 0 };
  let after: TransferPairGenerationCursor | null = null;
  do {
    const page = await generateTransferPairSuggestionsPage(db, {
      ...input,
      after,
    });
    total.found += page.found;
    total.published += page.published;
    total.unchanged += page.unchanged;
    total.retired += page.retired;
    if (page.failed.length)
      throw new Error(page.failed.map((failure) => failure.message).join("\n"));
    after = page.next;
  } while (after);
  return total;
}

const runScope = (runId: string | null | undefined) =>
  runId ? sql`AND s."runId" = ${runId}::uuid` : sql``;

/** A label pass's position in `(createdAt, id)` order. */
export type TransferPairLabelCursor = { createdAt: string; id: string };

/** Rule pairs awaiting movement labels or committed model publications awaiting their statement refresh. */
export async function transferPairsNeedingLabels(
  db: Database,
  input: {
    limit: number;
    after?: TransferPairLabelCursor | null;
    runId?: string | null;
  },
) {
  const { rows } = await unwrapDb(db).execute<{
    id: string;
    createdAt: string;
    data: unknown;
  }>(sql`
    SELECT s.id::text AS id, to_char(s."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "createdAt", s.data
    FROM "AssessmentState" s
    WHERE s.family = ${assessmentFamily.enum.transfer_pair}
      AND ((s.active AND s.status = ${suggestionStatus.enum.pending} AND (s.data->>'needsLabel')::boolean)
        OR coalesce((s.data->>'statementRefreshPending')::boolean, false)) ${runScope(input.runId)}
      ${input.after ? sql`AND (s."createdAt", s.id) > (${input.after.createdAt}::timestamp, ${input.after.id}::uuid)` : sql``}
    ORDER BY s."createdAt", s.id
    LIMIT ${input.limit}
  `);
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    data: transferPairStateData.parse(row.data),
  }));
}

/** Remaining movement-label or dependent-refresh work, for a Sweep's estimate. */
export async function countTransferPairsNeedingLabels(
  db: Database,
  input: { runId?: string | null } = {},
) {
  const { rows } = await unwrapDb(db).execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM "AssessmentState" s
    WHERE s.family = ${assessmentFamily.enum.transfer_pair}
      AND ((s.active AND s.status = ${suggestionStatus.enum.pending} AND (s.data->>'needsLabel')::boolean)
        OR coalesce((s.data->>'statementRefreshPending')::boolean, false)) ${runScope(input.runId)}
  `);
  return rows[0]?.count ?? 0;
}

type StoredPair = {
  id: string;
  fingerprint: string | null;
  data: TransferPairStateData;
  judgment: TransferPairJudgment;
};

/** Active pairs; `pending` also requires a pending status. */
async function storedPairs(
  db: Database,
  where: SQL,
  status: "pending" | "any" = "pending",
): Promise<StoredPair[]> {
  const { rows } = await unwrapDb(db).execute<{
    id: string;
    fingerprint: string | null;
    data: unknown;
    judgment: unknown;
  }>(sql`
    SELECT s.id::text AS id, s.fingerprint, s.data, a.judgment
    FROM "AssessmentState" s JOIN "Assessment" a ON a.id = s.id
    WHERE s.family = ${assessmentFamily.enum.transfer_pair} AND s.active
      ${status === "pending" ? sql`AND s.status = ${suggestionStatus.enum.pending}` : sql``}
      AND ${where}
    ORDER BY s.data->>'pairKey'
  `);
  return rows.map((row) => ({
    id: row.id,
    fingerprint: row.fingerprint,
    data: transferPairStateData.parse(row.data),
    judgment: transferPairJudgment.parse(row.judgment),
  }));
}

const legKeysAny = (keys: readonly string[]) =>
  sql`s.data->'legKeys' ?| ARRAY[${sql.join(
    keys.map((key) => sql`${key}`),
    sql`, `,
  )}]::text[]`;

/**
 * Each charge's published pair, fresh only while today's rule evidence still
 * matches the stored evidence. A charge in several pending pairs has
 * competitors, so it is never clean. Never builds statement proposals.
 */
export async function findTransferPairsForCharges(
  db: Database,
  charges: readonly ChargeRef[],
): Promise<Map<string, StatementTransferPairRef>> {
  const result = new Map<string, StatementTransferPairRef>();
  if (!charges.length) return result;
  const keys = charges.map((charge) => `stmt:${chargeId(charge)}`);
  const stored = await storedPairs(db, legKeysAny(keys));
  if (!stored.length) return result;
  const wanted = new Set(keys);
  const current = new Map(
    (
      await discover(db, {
        kind: "legs",
        keys: uniq(
          stored.flatMap((pair) =>
            pair.data.legKeys.filter((key) => wanted.has(key)),
          ),
        ),
      })
    ).map((pair) => [pair.judgment.key, pair]),
  );
  const byCharge = new Map<string, StatementTransferPairRef[]>();
  for (const pair of stored) {
    const now = current.get(pair.data.pairKey);
    const fresh =
      now !== undefined &&
      (await transferPairEvidenceFingerprint(now.judgment)) ===
        pair.data.evidenceFingerprint;
    for (const key of pair.data.legKeys.filter((leg) => wanted.has(leg))) {
      const charge = key.slice("stmt:".length);
      byCharge.set(charge, [
        ...(byCharge.get(charge) ?? []),
        {
          key: pair.data.pairKey,
          fingerprint: pair.fingerprint ?? "",
          clean: fresh && pair.data.clean,
        },
      ]);
    }
  }
  for (const [charge, refs] of byCharge)
    result.set(
      charge,
      refs.length === 1 ? refs[0]! : { ...refs[0]!, clean: false },
    );
  return result;
}

export async function findTransferPairForCharge(
  db: Database,
  charge: ChargeRef,
): Promise<StatementTransferPairRef | null> {
  return (
    (await findTransferPairsForCharges(db, [charge])).get(chargeId(charge)) ??
    null
  );
}

// ------------------------------------------------------------------ apply

/**
 * Create the missing legs and link the pair through `acceptFinancialTransferPair`,
 * in one transaction. `reviewed: false` (Accept clean, or a statement create
 * delegating here) refuses any pair that is not clean today; a cross-owner or
 * cash pair is never clean, so it needs a member's own review. Every refusal
 * rolls back the created legs.
 */
/** A source observation establishes posting only when it explicitly says so. */
async function currentStatementStatus(db: Database, leg: TransferPairLeg) {
  if (leg.origin === "cash") return financialTransactionStatus.enum.posted;
  if (!leg.charge)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A new transfer leg requires retained source identity.",
    );
  const { rows } = await unwrapDb(db).execute<{ providerStatus: unknown }>(sql`
    SELECT "providerStatus" FROM "StatementRow" WHERE source=${leg.charge.source}
      AND "chargeKey"=${leg.charge.chargeKey} AND current AND "withdrawnAt" IS NULL AND "deletedAt" IS NULL
  `);
  if (rows.length !== 1)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "The transfer's current source observation changed. Review again.",
    );
  return (
    financialTransactionProviderStatus
      .nullable()
      .parse(rows[0]!.providerStatus) ??
    financialTransactionStatus.enum.observed
  );
}

export async function applyTransferPair(
  db: Database,
  context: EntityKernelContext,
  input: {
    key: string;
    expectedFingerprint: string;
    reviewed?: boolean;
    /** The suggestion being applied, which its own handler marks applied. */
    stateId?: string;
  },
) {
  const actor = context.actorContext;
  return withTransaction(db, async (tx) => {
    const txDb = databaseForTransaction(tx);
    await assertWorkflowEffect(txDb);
    const legKeys = input.key.split("~");
    // Leg locks serialize every apply naming a leg, so a racing or replayed
    // accept rereads after the winner commits and finds the leg taken.
    await lockTransferPairLegs(txDb, input.key);
    const current = await buildTransferPair(txDb, input.key);
    if (!current)
      throw refused(
        "This transfer pair is no longer a candidate: a leg was paired, matched or removed. Refresh suggestions and review again.",
      );
    const raw = current.judgment;
    // Any status: the suggestion's own handler marks it applied first.
    const published = (
      await storedPairs(txDb, sql`s.data->>'pairKey' = ${input.key}`, "any")
    ).find((pair) => pair.fingerprint === input.expectedFingerprint);
    let judgment: TransferPairJudgment;
    if (published) {
      if (
        (await transferPairEvidenceFingerprint(raw)) !==
        published.data.evidenceFingerprint
      )
        throw refused(
          "The transfer evidence changed since this pair was suggested. Refresh suggestions and review again.",
        );
      judgment = labelTransferPair(raw, {
        outflow: published.judgment.outflow.movementLabel,
        inflow: published.judgment.inflow.movementLabel,
      });
    } else if (
      (await fingerprintTransferPair(raw)) === input.expectedFingerprint
    )
      judgment = raw;
    else
      throw refused(
        "The transfer evidence changed since this pair was suggested. Refresh suggestions and review again.",
      );
    if (!judgment.apply.available) throw refused(judgment.apply.reason!);
    if (!input.reviewed && !judgment.clean)
      throw refused(
        `This pair needs review before it can be accepted: ${judgment.reasons.join(" ")}`,
      );

    const create = async (leg: TransferPairLeg) => {
      if (leg.transactionId) return leg.transactionId;
      const status = await currentStatementStatus(txDb, leg);
      if (leg.charge)
        await updateStatementRows(
          txDb,
          {
            selector: {
              source: leg.charge.source,
              externalIds: leg.refs
                .filter((ref) => ref.source === leg.charge!.source)
                .map((ref) => ref.externalId),
            },
            data: { accountId: leg.accountId },
          },
          actor,
        );
      const { output } = await createFinancialTransaction(
        txDb,
        financialTransactionCreateInput.parse({
          accountId: leg.accountId,
          purchaseId: null,
          kind: leg.kind,
          status,
          amount: leg.amount,
          transactionDate:
            status !== "posted" || leg.origin === "cash" ? leg.date : null,
          postedDate: status === "posted" ? leg.date : null,
          merchant: leg.merchant,
          rawDescription: leg.description,
          sourceCategory: leg.signals.providerCategory,
          sourceRefs: leg.refs,
          notes: null,
        }),
        actor,
      );
      if (!output)
        throw new Error(
          "Created transfer leg was not readable in its transaction",
        );
      return output.id;
    };
    const outflowTransactionId = await create(judgment.outflow);
    const inflowTransactionId = await create(judgment.inflow);
    const accepted = await acceptFinancialTransferPair(
      txDb,
      { outflowTransactionId, inflowTransactionId },
      actor,
    );
    if (!accepted.canProceed) throw refused(accepted.reason);
    // Every other pending pair naming either leg lost it.
    await transitionAssessmentStates(
      tx,
      sql`${assessmentState.family} = ${assessmentFamily.enum.transfer_pair} AND ${assessmentState.active} AND ${assessmentState.status} = ${suggestionStatus.enum.pending}
        AND ${assessmentState.data}->'legKeys' ?| ARRAY[${sql.join(
          legKeys.map((key) => sql`${key}`),
          sql`, `,
        )}]::text[]
        ${input.stateId ? sql`AND ${assessmentState.id} <> ${input.stateId}::uuid` : sql``}`,
      { active: false, status: "superseded" },
      { kind: "transfer_pair_leg_taken" },
    );
    return {
      transferId: accepted.transferId,
      outflowTransactionId,
      inflowTransactionId,
      internalMove: accepted.internalMove,
    };
  });
}

/** The `transfer_pair` family's review apply: the member accepts the published pair. */
export async function applyTransferPairSuggestion(
  db: Database,
  context: EntityKernelContext,
  state: typeof assessmentState.$inferSelect,
  input: Pick<z.infer<typeof assessmentReviewInput>, "expectedFingerprint">,
) {
  return withTransactionDatabase(db, async (tx) => {
    await assertWorkflowEffect(tx);
    const [prediction] = await getDb(tx)
      .select({ subject: assessment.subject, judgment: assessment.judgment })
      .from(assessment)
      .where(eq(assessment.id, state.id))
      .limit(1);
    const subject = assessmentSubjects.transfer_pair.parse(prediction?.subject);
    const published = transferPairJudgment.parse(prediction?.judgment);
    if (state.status !== "pending" || !state.fingerprint)
      throw refused("This transfer pair suggestion is no longer pending.");
    await transitionAssessmentState(
      tx,
      state.id,
      { status: "applied" },
      { kind: "transfer_pair_applied" },
    );
    await applyTransferPair(tx, context, {
      key: subject.pairKey,
      expectedFingerprint: input.expectedFingerprint ?? state.fingerprint,
      // Accepting a clean pair still holds it to today's clean rule.
      reviewed: !published.clean,
      stateId: state.id,
    });
  });
}
