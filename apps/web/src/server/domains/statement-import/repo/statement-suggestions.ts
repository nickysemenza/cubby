import { suggestionStatus } from "@cubby/schemas/ai";
import {
  assessmentFamily,
  assessmentJudgments,
  type AssessmentProducer,
} from "@cubby/schemas/assessment";
import {
  FINANCIAL_STATEMENT_IMPORT_MAX_ROWS,
  type FinancialStatementImportRow,
} from "@cubby/schemas/financial-transaction";
import { financialTransactionStatus } from "@cubby/schemas/financial-transaction";
import { statementRowProviderStatus } from "@cubby/schemas/statement-row";
import {
  type StatementTransactionCandidate,
  type StatementTransactionJudgment,
} from "@cubby/schemas/statement-suggestion";
import { cents } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { plainDateDaysBetween } from "~/lib/household-date";
import type { Database } from "~/server/db";
import { getDb, unwrapDb, withTransactionDatabase } from "~/server/db/helpers";
import { previewFinancialStatementImport } from "~/server/domains/financial-transaction/repo/financial-statement-preview";
import {
  CHARGE_STATE,
  chargeKeyOf,
  suggestionField,
  suggestionRefKey,
} from "~/server/domains/statement-import/repo/statement-charge";
import { statementImportMembers } from "~/server/domains/statement-import/repo/statement-import-membership";
import { statementTransactionKind } from "~/server/domains/statement-import/repo/statement-transaction-kind";
import { canonicalJson } from "~/server/entity-kernel/repo/entity-source";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";

/** Rule revision stamped on every published suggestion; bump with any policy change. */
export const STATEMENT_SUGGESTION_REVISION = "2026-10-17.1";
export const STATEMENT_SUGGESTION_PAGE = FINANCIAL_STATEMENT_IMPORT_MAX_ROWS;
/** A hold's posted twin lands within this window, and a vanished hold is judged after it. */
export const PENDING_POST_WINDOW_DAYS = 7;
const SIBLING_WINDOW_DAYS = 3;

export type ChargeRef = { source: string; chargeKey: string };
export const chargeId = (charge: ChargeRef) =>
  `${charge.source}:${charge.chargeKey}`;

type Observation = {
  id: string;
  source: string;
  externalId: string;
  chargeKey: string;
  rowPosition: number | null;
  providerTransactionId: string | null;
  accountDescriptor: string;
  statementDate: string;
  providerAmount: number;
  amount: number;
  merchant: string | null;
  rawDescription: string;
  sourceCategory: string | null;
  providerStatus: "posted" | "pending" | null;
  providerNotes: string | null;
  accountId: string | null;
  createdAt: string;
  importFingerprint: string;
};

export type ChargeProposal = {
  charge: ChargeRef;
  canonical: Observation;
  observations: Observation[];
  judgment: StatementTransactionJudgment;
  /** Publication fingerprint: the evidence plus any model labels. */
  fingerprint: string;
  /** The ledger and transaction evidence alone, recomputed at apply. */
  evidenceFingerprint: string;
  refs: string[];
};

const plainDateOf = (value: unknown) =>
  value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
    : String(value).slice(0, 10);

const tuples = (charges: readonly ChargeRef[]) =>
  sql.join(
    charges.map((charge) => sql`(${charge.source}, ${charge.chargeKey})`),
    sql`, `,
  );

/** Unmatched charges in `(source, chargeKey)` order after the cursor. */
export async function nextUnmatchedCharges(
  db: Database,
  input: { after: ChargeRef | null; limit: number },
): Promise<ChargeRef[]> {
  const after = input.after
    ? sql`AND (cs.source, cs."chargeKey") > (${input.after.source}, ${input.after.chargeKey})`
    : sql``;
  const { rows } = await unwrapDb(db).execute<ChargeRef>(sql`
    SELECT cs.source, cs."chargeKey" FROM ${CHARGE_STATE} cs
    WHERE NOT cs.ignored AND NOT cs.superseded AND cs.shortcode IS NULL ${after}
    ORDER BY cs.source, cs."chargeKey"
    LIMIT ${input.limit}
  `);
  return rows.map((row) => ({ source: row.source, chargeKey: row.chargeKey }));
}

async function loadObservations(
  db: Database,
  charges: readonly ChargeRef[],
): Promise<Observation[]> {
  if (!charges.length) return [];
  const { rows } = await unwrapDb(db).execute<
    Record<string, string | number | Date | null>
  >(sql`
    SELECT r.id, r.source, r."externalId", ${chargeKeyOf("r")} AS "chargeKey",
      r."rowPosition", r."providerTransactionId", r."accountDescriptor",
      r."statementDate", r."providerAmount", r.amount, r.merchant,
      r."rawDescription", r."sourceCategory", r."providerStatus",
      r."providerNotes", r."accountId", r."createdAt", si.fingerprint AS "importFingerprint"
    FROM "StatementRow" r
    JOIN "StatementImport" si ON si.id = r."batchId"
    WHERE r."deletedAt" IS NULL
      AND (r.source, ${chargeKeyOf("r")}) IN (${tuples(charges)})
    ORDER BY r."createdAt" DESC, r.id
  `);
  return rows.map((row) => ({
    id: String(row.id),
    source: String(row.source),
    externalId: String(row.externalId),
    chargeKey: String(row.chargeKey),
    rowPosition: row.rowPosition === null ? null : Number(row.rowPosition),
    providerTransactionId:
      row.providerTransactionId === null
        ? null
        : String(row.providerTransactionId),
    accountDescriptor: String(row.accountDescriptor),
    statementDate: plainDateOf(row.statementDate),
    providerAmount: Number(row.providerAmount),
    amount: Number(row.amount),
    merchant: row.merchant === null ? null : String(row.merchant),
    rawDescription: String(row.rawDescription),
    sourceCategory:
      row.sourceCategory === null ? null : String(row.sourceCategory),
    providerStatus:
      row.providerStatus === null
        ? null
        : z.enum(["posted", "pending"]).parse(row.providerStatus),
    providerNotes:
      row.providerNotes === null ? null : String(row.providerNotes),
    accountId: row.accountId === null ? null : String(row.accountId),
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt),
    importFingerprint: String(row.importFingerprint),
  }));
}

/** The newest observation with a physical position names the charge's settlement ref. */
const canonicalObservation = (observations: Observation[]) =>
  observations.find((row) => row.rowPosition !== null) ?? observations[0]!;

const previewRowFor = (
  charge: ChargeRef,
  row: Observation,
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
  ...(row.providerStatus ? { providerStatus: row.providerStatus } : {}),
});

type PendingTransaction = {
  id: string;
  accountId: string;
  amount: number;
  status: "pending";
  postedDate: string | null;
  transactionDate: string | null;
  merchant: string | null;
  rawDescription: string | null;
  pendingRowIds: string[];
};

/**
 * Pending transactions whose every live settlement ref names a statement row
 * the provider reported as pending: holds this ledger itself recorded.
 */
export async function statementPendingTransactions(
  db: Database,
  accountIds: readonly string[],
): Promise<PendingTransaction[]> {
  if (!accountIds.length) return [];
  const { rows } = await unwrapDb(db).execute<
    Record<string, string | number | Date | null | string[]>
  >(sql`
    SELECT ft.id, ft."accountId", ft.amount, ft.status, ft."postedDate",
      ft."transactionDate", ft.merchant, ft."rawDescription",
      array_agg(DISTINCT sr.id) AS "pendingRowIds"
    FROM "FinancialTransaction" ft
    JOIN "EntityExternalId" fx ON fx."entityId" = ft.id
      AND fx.kind = 'settlement_ref' AND fx."deletedAt" IS NULL
    JOIN "StatementRow" sr ON sr.source = fx.source AND sr."externalId" = fx."externalId"
      AND sr."deletedAt" IS NULL AND sr."providerStatus" = ${statementRowProviderStatus.enum.pending}
    WHERE ft."deletedAt" IS NULL AND ft.status = ${financialTransactionStatus.enum.pending}
      AND ft."accountId" IN (${sql.join(
        accountIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      AND NOT EXISTS (
        SELECT 1 FROM "EntityExternalId" other
        WHERE other."entityId" = ft.id AND other.kind = 'settlement_ref'
          AND other."deletedAt" IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM "StatementRow" held
            WHERE held.source = other.source AND held."externalId" = other."externalId"
              AND held."deletedAt" IS NULL AND held."providerStatus" = ${statementRowProviderStatus.enum.pending}
          )
      )
    GROUP BY ft.id
  `);
  return rows.map((row) => ({
    id: String(row.id),
    accountId: String(row.accountId),
    amount: Number(row.amount),
    status: "pending",
    postedDate: row.postedDate === null ? null : plainDateOf(row.postedDate),
    transactionDate:
      row.transactionDate === null ? null : plainDateOf(row.transactionDate),
    merchant: row.merchant === null ? null : String(row.merchant),
    rawDescription:
      row.rawDescription === null ? null : String(row.rawDescription),
    pendingRowIds: z.array(z.string()).parse(row.pendingRowIds).sort(),
  }));
}

/**
 * A posted amount may exceed its hold by a tip or incidentals: up to the
 * larger of 25% or $20, never below it, same direction, within the window.
 */
export function pendingPostedMatch(
  pending: { amount: number; date: string | null },
  posted: { amount: number; date: string },
): boolean {
  if (!pending.date) return false;
  if (Math.sign(pending.amount) !== Math.sign(posted.amount)) return false;
  const held = Math.abs(cents(pending.amount));
  const settled = Math.abs(cents(posted.amount));
  const allowance = Math.max(Math.round(held * 0.25), 2000);
  return (
    settled >= held &&
    settled <= held + allowance &&
    Math.abs(plainDateDaysBetween(pending.date, posted.date)) <=
      PENDING_POST_WINDOW_DAYS
  );
}

async function siblingsFor(
  db: Database,
  proposals: readonly { charge: ChargeRef; observations: Observation[] }[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (!proposals.length) return result;
  const values = sql.join(
    proposals.map(({ charge, observations }) => {
      const row = observations[0]!;
      return sql`(${chargeId(charge)}, ${charge.source}, ${charge.chargeKey}, ${row.accountDescriptor}, ${row.providerAmount}::numeric, ${row.statementDate}::date, ${`{${observations.map((o) => o.id).join(",")}}`}::uuid[])`;
    }),
    sql`, `,
  );
  const { rows } = await unwrapDb(db).execute<{
    key: string;
    siblings: string[];
  }>(sql`
    SELECT p.key, array_agg(DISTINCT ${chargeKeyOf("o")} ORDER BY ${chargeKeyOf("o")}) AS siblings
    FROM (VALUES ${values}) AS p(key, source, "chargeKey", descriptor, amount, day, "rowIds")
    JOIN "StatementRow" o ON o.source = p.source
      AND o."accountDescriptor" = p.descriptor
      AND o."providerAmount" = p.amount
      AND o."statementDate" BETWEEN p.day - ${SIBLING_WINDOW_DAYS}::int AND p.day + ${SIBLING_WINDOW_DAYS}::int
      AND o."deletedAt" IS NULL
      AND ${chargeKeyOf("o")} <> p."chargeKey"
    JOIN ${CHARGE_STATE} cs ON cs.source = o.source AND cs."chargeKey" = ${chargeKeyOf("o")}
      AND NOT cs.ignored AND NOT cs.superseded AND cs.shortcode IS NULL
    -- One export speaks one descriptor vocabulary: two of its own rows are two
    -- real charges, so only another export's row can be this money again.
    WHERE NOT EXISTS (
      SELECT 1 FROM ${statementImportMembers} mo
      JOIN ${statementImportMembers} mp ON mp."importId" = mo."importId"
      WHERE mo."statementRowId" = o.id AND mp."statementRowId" = ANY(p."rowIds")
    )
    GROUP BY p.key
  `);
  for (const row of rows) result.set(row.key, row.siblings.map(String));
  return result;
}

const diffFor = (
  candidate: {
    amount: number;
    status: string;
    postedDate: string | null;
  },
  row: { amount: number; status: "posted" | "pending"; date: string },
) => {
  const fields: StatementTransactionCandidate["diff"] = [];
  if (cents(candidate.amount) !== cents(row.amount)) fields.push("amount");
  if (row.status === "posted" && candidate.postedDate !== row.date)
    fields.push("postedDate");
  if (candidate.status !== row.status) fields.push("status");
  return fields;
};

/**
 * Current proposals for these charges, computed from the ledger and the
 * transactions as they stand. Generation publishes them; apply recomputes them
 * and refuses when the fingerprint moved.
 */
export async function buildChargeProposals(
  db: Database,
  charges: readonly ChargeRef[],
): Promise<ChargeProposal[]> {
  const observations = await loadObservations(db, charges);
  const byCharge = new Map<string, Observation[]>();
  for (const row of observations) {
    const key = chargeId(row);
    byCharge.set(key, [...(byCharge.get(key) ?? []), row]);
  }
  const grouped = charges.flatMap((charge) => {
    const rows = byCharge.get(chargeId(charge));
    return rows?.length && rows[0]!.providerAmount !== 0
      ? [{ charge, observations: rows, canonical: canonicalObservation(rows) }]
      : [];
  });
  if (!grouped.length) return [];
  const preview = await previewFinancialStatementImport(
    db,
    {
      rows: grouped.map(({ charge, canonical }) =>
        previewRowFor(charge, canonical),
      ),
    },
    undefined,
    {
      candidatePolicy: "suggestion",
      accountHints: new Map(
        grouped.flatMap(({ charge, observations: rows }) => {
          const stored = rows.find((row) => row.accountId)?.accountId;
          return stored ? [[chargeId(charge), stored] as const] : [];
        }),
      ),
    },
  );
  const previewByKey = new Map(preview.rows.map((row) => [row.key, row]));
  const shortcodes = [
    ...new Set(
      preview.rows.flatMap((row) => [
        ...row.existingTransactionIds,
        ...(row.accountId ? [row.accountId] : []),
      ]),
    ),
  ];
  const ids = new Map<string, string>();
  if (shortcodes.length) {
    const { rows } = await unwrapDb(db).execute<{
      id: string;
      shortcode: string;
    }>(sql`
      SELECT id, shortcode FROM "FinancialTransaction" WHERE shortcode IN (${sql.join(
        shortcodes.map((code) => sql`${code}`),
        sql`, `,
      )})
      UNION ALL
      SELECT id, shortcode FROM "FinancialAccount" WHERE shortcode IN (${sql.join(
        shortcodes.map((code) => sql`${code}`),
        sql`, `,
      )})
    `);
    for (const row of rows) ids.set(row.shortcode, String(row.id));
  }
  const accountIds = [
    ...new Set(
      preview.rows.flatMap((row) =>
        row.accountId && ids.get(row.accountId)
          ? [ids.get(row.accountId)!]
          : [],
      ),
    ),
  ];
  const [pendingTransactions, siblings] = await Promise.all([
    statementPendingTransactions(db, accountIds),
    siblingsFor(db, grouped),
  ]);

  const proposals: ChargeProposal[] = [];
  for (const { charge, observations: rows, canonical } of grouped) {
    const row = previewByKey.get(chargeId(charge));
    if (
      !row ||
      !row.accountId ||
      row.status === "unresolved_account" ||
      row.status === "indistinguishable_duplicate"
    )
      continue;
    const accountId = ids.get(row.accountId);
    if (!accountId) continue;
    const providerStatus =
      canonical.providerStatus === "pending" ? "pending" : "posted";
    const statementAmount = row.proposed.amount;
    const candidates: StatementTransactionCandidate[] =
      row.existingTransactions.flatMap((existing) => {
        const transactionId = ids.get(existing.id);
        return transactionId
          ? [
              {
                transactionId,
                amount: existing.amount,
                status: existing.status,
                postedDate: existing.postedDate,
                transactionDate: existing.transactionDate,
                merchant: existing.merchant,
                rawDescription: existing.rawDescription,
                diff: diffFor(existing, {
                  amount: statementAmount,
                  status: providerStatus,
                  date: canonical.statementDate,
                }),
                label: null,
              },
            ]
          : [];
      });
    // A posted row may settle a hold this ledger recorded, at a different
    // amount or date than the nearby rule admits.
    const holds =
      providerStatus === "posted"
        ? pendingTransactions.filter(
            (pending) =>
              pending.accountId === accountId &&
              pendingPostedMatch(
                {
                  amount: pending.amount,
                  date: pending.transactionDate ?? pending.postedDate,
                },
                { amount: statementAmount, date: canonical.statementDate },
              ),
          )
        : [];
    for (const hold of holds)
      if (!candidates.some((c) => c.transactionId === hold.id))
        candidates.push({
          transactionId: hold.id,
          amount: hold.amount,
          status: "pending",
          postedDate: hold.postedDate,
          transactionDate: hold.transactionDate,
          merchant: hold.merchant,
          rawDescription: hold.rawDescription,
          diff: diffFor(
            {
              amount: hold.amount,
              status: "pending",
              postedDate: hold.postedDate,
            },
            {
              amount: statementAmount,
              status: "posted",
              date: canonical.statementDate,
            },
          ),
          label: null,
        });
    candidates.sort(
      (a, b) =>
        Number(cents(a.amount) !== cents(statementAmount)) -
          Number(cents(b.amount) !== cents(statementAmount)) ||
        a.transactionId.localeCompare(b.transactionId),
    );
    const hold = holds.find((pending) =>
      candidates.some((c) => c.transactionId === pending.id),
    );
    const { kind, kindSource } = statementTransactionKind({
      sourceCategory: canonical.sourceCategory,
      amount: statementAmount,
    });
    const chargeSiblings = siblings.get(chargeId(charge)) ?? [];
    const recommended = hold
      ? "supersede"
      : candidates.length
        ? "attach"
        : "create";
    const judgment: StatementTransactionJudgment = {
      recommended,
      accountId,
      statementDate: canonical.statementDate,
      providerStatus,
      create: {
        kind,
        kindSource,
        status: providerStatus,
        amount: statementAmount,
        transactionDate:
          providerStatus === "pending" ? canonical.statementDate : null,
        postedDate:
          providerStatus === "posted" ? canonical.statementDate : null,
        merchant: canonical.merchant,
        rawDescription: canonical.rawDescription,
        sourceCategory: canonical.sourceCategory,
        notes: canonical.providerNotes,
        sourceRef: row.proposed.sourceRef,
      },
      candidates,
      supersede: hold
        ? {
            pendingTransactionId: hold.id,
            pendingRowIds: hold.pendingRowIds,
            postedRowId: canonical.id,
          }
        : null,
      void: null,
      siblings: chargeSiblings,
      clean: false,
    };
    judgment.clean = isClean(judgment, statementAmount);
    proposals.push(await finishProposal(charge, canonical, rows, judgment));
  }
  return proposals;
}

/** Bulk acceptance never changes an amount or relies on a heuristic kind. */
export function isClean(
  judgment: StatementTransactionJudgment,
  statementAmount: number,
): boolean {
  if (judgment.siblings.length) return false;
  if (judgment.recommended === "create")
    return (
      judgment.candidates.length === 0 && judgment.create?.kindSource === "rule"
    );
  if (judgment.candidates.length !== 1) return false;
  const [only] = judgment.candidates;
  if (cents(only!.amount) !== cents(statementAmount)) return false;
  if (judgment.recommended === "supersede") return true;
  return (
    judgment.recommended === "attach" &&
    only!.label?.same === "same" &&
    only!.label.confidence === "high"
  );
}

async function finishProposal(
  charge: ChargeRef,
  canonical: Observation,
  observations: Observation[],
  judgment: StatementTransactionJudgment,
): Promise<ChargeProposal> {
  assessmentJudgments.statement_transaction.parse(judgment);
  const fingerprint = await sha256Hex(
    canonicalJson({
      revision: STATEMENT_SUGGESTION_REVISION,
      judgment,
      observations: observations
        .map((row) => [
          row.id,
          row.externalId,
          row.accountDescriptor,
          row.statementDate,
          cents(row.providerAmount),
          row.rawDescription,
          row.providerStatus,
        ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    }),
  );
  const refs = [
    ...new Set([
      suggestionRefKey(charge.source, charge.chargeKey),
      ...observations.map((row) =>
        suggestionRefKey(row.source, row.externalId),
      ),
    ]),
  ].sort();
  return {
    charge,
    canonical,
    observations,
    judgment,
    fingerprint,
    evidenceFingerprint: fingerprint,
    refs,
  };
}

/** Model labels ride on the evidence fingerprint rather than replacing it. */
export async function labelledProposal(
  proposal: ChargeProposal,
  judgment: StatementTransactionJudgment,
): Promise<ChargeProposal> {
  assessmentJudgments.statement_transaction.parse(judgment);
  return {
    ...proposal,
    judgment,
    fingerprint: await sha256Hex(
      canonicalJson({
        evidence: proposal.evidenceFingerprint,
        candidates: judgment.candidates.map((c) => [c.transactionId, c.label]),
        kind: judgment.create
          ? [judgment.create.kind, judgment.create.kindSource]
          : null,
      }),
    ),
  };
}

/**
 * Vanished holds: a transaction this ledger recorded from pending rows, with no
 * posted twin, that a later export of the same account no longer contains
 * although it covers dates a full window past the hold.
 */
export async function buildHoldVoidProposals(
  db: Database,
  accountIds?: readonly string[],
): Promise<ChargeProposal[]> {
  const accounts =
    accountIds ??
    (
      await unwrapDb(db).execute<{ id: string }>(sql`
        SELECT DISTINCT ft."accountId" AS id FROM "FinancialTransaction" ft
        WHERE ft."deletedAt" IS NULL AND ft.status = ${financialTransactionStatus.enum.pending}
      `)
    ).rows.map((row) => String(row.id));
  const holds = await statementPendingTransactions(db, accounts);
  const proposals: ChargeProposal[] = [];
  for (const hold of holds) {
    const date = hold.transactionDate ?? hold.postedDate;
    if (!date) continue;
    const rows = await loadObservationsById(db, hold.pendingRowIds);
    if (!rows.length) continue;
    const canonical = rows[0]!;
    const coverage = await laterCoveringImport(db, {
      source: canonical.source,
      accountDescriptor: canonical.accountDescriptor,
      after: rows
        .map((row) => row.createdAt)
        .sort()
        .at(-1)!,
      coveredThrough: date,
      rowIds: hold.pendingRowIds,
    });
    if (!coverage) continue;
    const posted = await postedTwinExists(db, hold, date);
    if (posted) continue;
    const charge = { source: canonical.source, chargeKey: canonical.chargeKey };
    proposals.push(
      await finishProposal(charge, canonical, rows, {
        recommended: "void",
        accountId: hold.accountId,
        statementDate: canonical.statementDate,
        providerStatus: "pending",
        create: null,
        candidates: [],
        supersede: null,
        void: { transactionId: hold.id, coverageImportId: coverage },
        siblings: [],
        clean: false,
      }),
    );
  }
  return proposals;
}

async function loadObservationsById(db: Database, rowIds: readonly string[]) {
  if (!rowIds.length) return [];
  const { rows } = await unwrapDb(db).execute<ChargeRef>(sql`
    SELECT DISTINCT r.source, ${chargeKeyOf("r")} AS "chargeKey" FROM "StatementRow" r
    WHERE r.id IN (${sql.join(
      rowIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}) AND r."deletedAt" IS NULL
  `);
  const all = await loadObservations(db, rows);
  return all.filter((row) => rowIds.includes(row.id));
}

/** The import proving the hold vanished: newer, same account, past the window, without it. */
export async function laterCoveringImport(
  db: Database,
  input: {
    source: string;
    accountDescriptor: string;
    after: string;
    coveredThrough: string;
    rowIds: readonly string[];
  },
): Promise<string | null> {
  const { rows } = await unwrapDb(db).execute<{ id: string }>(sql`
    SELECT si.id FROM "StatementImport" si
    WHERE si."deletedAt" IS NULL AND si.source = ${input.source}
      AND si."createdAt" > ${input.after}::timestamptz
      AND EXISTS (
        SELECT 1 FROM ${statementImportMembers} m
        JOIN "StatementRow" r ON r.id = m."statementRowId" AND r."deletedAt" IS NULL
        WHERE m."importId" = si.id AND r."accountDescriptor" = ${input.accountDescriptor}
          AND r."statementDate" >= ${input.coveredThrough}::date + ${PENDING_POST_WINDOW_DAYS}::int
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${statementImportMembers} m
        JOIN "StatementRow" held ON held.id = m."statementRowId" AND held."deletedAt" IS NULL
        JOIN "StatementRow" seen ON seen.source = held.source AND seen."deletedAt" IS NULL
          AND ${chargeKeyOf("seen")} = ${chargeKeyOf("held")}
        JOIN ${statementImportMembers} ms ON ms."statementRowId" = seen.id AND ms."importId" = si.id
        WHERE held.id IN (${sql.join(
          input.rowIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      )
    ORDER BY si."createdAt", si.id
    LIMIT 1
  `);
  return rows[0] ? String(rows[0].id) : null;
}

async function postedTwinExists(
  db: Database,
  hold: PendingTransaction,
  date: string,
): Promise<boolean> {
  const { rows } = await unwrapDb(db).execute<{
    amount: string;
    statementDate: unknown;
  }>(sql`
    SELECT r.amount, r."statementDate" FROM "StatementRow" r
    WHERE r."deletedAt" IS NULL
      AND r."providerStatus" IS DISTINCT FROM ${statementRowProviderStatus.enum.pending}
      AND r."statementDate" BETWEEN ${date}::date - ${PENDING_POST_WINDOW_DAYS}::int
        AND ${date}::date + ${PENDING_POST_WINDOW_DAYS}::int
      AND sign(r.amount) = sign(${hold.amount}::numeric)
      AND r."accountDescriptor" IN (
        SELECT held."accountDescriptor" FROM "StatementRow" held
        WHERE held.id IN (${sql.join(
          hold.pendingRowIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      )
  `);
  return rows.some((row) =>
    pendingPostedMatch(
      { amount: hold.amount, date },
      { amount: Number(row.amount), date: plainDateOf(row.statementDate) },
    ),
  );
}

export type PublishOutcome = "published" | "unchanged" | "suppressed";

/**
 * Publish one charge's proposal. The charge's current suggestions are locked
 * first, so a member reviewing one serializes with its replacement: a
 * dismissal (suppression) holds forever, an unchanged fingerprint is left
 * alone, and anything else is retired before the new one takes the charge.
 */
export async function publishChargeProposal(
  db: Database,
  proposal: ChargeProposal,
  producer: AssessmentProducer,
): Promise<PublishOutcome> {
  const { charge } = proposal;
  return withTransactionDatabase(db, async (tx) => {
    const client = getDb(tx);
    await client.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`statement-suggestion:${chargeId(charge)}`}, 0))`,
    );
    const { rows: prior } = await client.execute<{
      id: string;
      status: string;
      fingerprint: string | null;
      evidenceFingerprint: string | null;
      suppression: unknown;
      active: boolean;
    }>(sql`
      SELECT id, status, fingerprint, ${suggestionField("evidenceFingerprint", "AssessmentState")} AS "evidenceFingerprint",
        suppression, active FROM "AssessmentState"
      WHERE family = ${assessmentFamily.enum.statement_transaction}
        AND ${suggestionField("source", "AssessmentState")} = ${charge.source}
        AND ${suggestionField("chargeKey", "AssessmentState")} = ${charge.chargeKey}
      FOR UPDATE
    `);
    if (prior.some((row) => row.suppression !== null)) return "suppressed";
    // A rule re-run never displaces labels a model added to the same evidence.
    if (
      prior.some(
        (row) =>
          row.active &&
          (row.fingerprint === proposal.fingerprint ||
            (producer.kind === "rule" &&
              row.evidenceFingerprint === proposal.evidenceFingerprint)),
      )
    )
      return "unchanged";
    const retire = prior.filter((row) => row.active).map((row) => row.id);
    if (retire.length)
      await client.execute(sql`
        UPDATE "AssessmentState"
        SET active = false,
          status = CASE WHEN status = ${suggestionStatus.enum.pending} THEN ${suggestionStatus.enum.superseded} ELSE status END,
          "updatedAt" = now()
        WHERE id IN (${sql.join(
          retire.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      `);
    const { judgment } = proposal;
    await publishAssessment(
      tx,
      {
        publicationKey: `statement_transaction:${chargeId(charge)}:${proposal.fingerprint}:${prior.length}`,
        family: "statement_transaction",
        subject: {
          kind: "statement_transaction",
          entity: "statementRow",
          recordId: proposal.canonical.id,
          source: charge.source,
          chargeKey: charge.chargeKey,
        },
        judgment,
        fingerprint: proposal.fingerprint,
        producer,
        evidence: {
          observations: proposal.observations.map((row) => row.id),
        },
      },
      {
        model: producer.model ?? "rule",
        confidence: judgment.clean ? 1 : 0,
        data: {
          source: charge.source,
          chargeKey: charge.chargeKey,
          accountId: judgment.accountId,
          month: judgment.statementDate.slice(0, 7),
          statementDate: judgment.statementDate,
          amount: judgment.create?.amount ?? proposal.canonical.amount,
          recommended: judgment.recommended,
          clean: judgment.clean,
          refs: proposal.refs,
          evidenceFingerprint: proposal.evidenceFingerprint,
        },
      },
    );
    return "published";
  });
}

export const ruleProducer = (runId: string | null): AssessmentProducer => ({
  kind: "rule",
  model: null,
  revision: STATEMENT_SUGGESTION_REVISION,
  runId,
  evaluationId: null,
});

/** One generation page: deterministic, safe to repeat, resumable at `next`. */
export async function generateStatementSuggestionPage(
  db: Database,
  input: { after: ChargeRef | null; runId: string | null; limit?: number },
): Promise<{
  published: number;
  unchanged: number;
  next: ChargeRef | null;
}> {
  const limit = input.limit ?? STATEMENT_SUGGESTION_PAGE;
  const charges = await nextUnmatchedCharges(db, {
    after: input.after,
    limit,
  });
  let published = 0;
  let unchanged = 0;
  const proposals = await buildChargeProposals(db, charges);
  // The final page also judges vanished holds, whose charges are matched.
  if (charges.length < limit)
    proposals.push(...(await buildHoldVoidProposals(db)));
  for (const proposal of proposals) {
    const outcome = await publishChargeProposal(
      db,
      proposal,
      ruleProducer(input.runId),
    );
    if (outcome === "published") published++;
    else unchanged++;
  }
  return {
    published,
    unchanged,
    next: charges.length === limit ? charges.at(-1)! : null,
  };
}
