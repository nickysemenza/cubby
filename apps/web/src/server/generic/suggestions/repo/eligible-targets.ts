/* eslint-disable cubby/require-soft-delete-filter -- Retained occurrence and alias reservations survive tombstones. */
import { expenseEconomicRoleSchema } from "@cubby/schemas/expense-fields";
import { expenseLineKindSchema } from "@cubby/schemas/expense-line-kind";
import { financialTransactionStatus } from "@cubby/schemas/financial-transaction-fields";
import { sourceTransactionRecordDisposition } from "@cubby/schemas/source-transaction-record-fields";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { requestedRows } from "~/server/db/helpers/requested";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";

type TargetKind = "purchase" | "financialTransaction";
type TargetEligibility = "explicit" | "eligible" | "context";
type TargetContextReason =
  | "settled"
  | "claimed"
  | "sign"
  | "amount"
  | "kind"
  | "void";
export type TargetRequest = {
  key: string;
  kind: TargetKind;
  ids: readonly string[];
  explicitIds: readonly string[];
  amountMinor: number;
  owner?: { source: string; chargeKey: string };
  currentTransactionId?: string;
};
export type ClassifiedTarget = {
  id: string;
  eligibility: TargetEligibility;
  reason: TargetContextReason | null;
  remainingMinor: number | null;
};
type TargetFact = {
  id: string;
  void: boolean;
  transfer: boolean;
  amountMinor: number | null;
  remainingMinor: number | null;
  claimed: boolean;
  owned: boolean;
};

function classifyTarget(
  req: TargetRequest,
  fact: TargetFact,
): ClassifiedTarget {
  const result = (
    eligibility: TargetEligibility,
    reason: TargetContextReason | null,
  ): ClassifiedTarget => ({
    id: fact.id,
    eligibility,
    reason,
    remainingMinor: fact.remainingMinor,
  });
  if (req.explicitIds.includes(fact.id)) return result("explicit", null);
  if (fact.void) return result("context", "void");
  if (fact.transfer) return result("context", "kind");
  if (
    fact.amountMinor !== null &&
    fact.amountMinor !== 0 &&
    Math.sign(fact.amountMinor) !== Math.sign(req.amountMinor)
  )
    return result("context", "sign");
  if (req.kind === "purchase") {
    if (fact.remainingMinor === 0) return result("context", "settled");
    if (
      fact.remainingMinor !== null &&
      Math.abs(fact.remainingMinor) < Math.abs(req.amountMinor)
    )
      return result("context", "amount");
  } else {
    if (fact.claimed) return result("context", "claimed");
    if (fact.owned && fact.amountMinor !== req.amountMinor)
      return result("context", "amount");
  }
  return result("eligible", null);
}

export async function eligibleTargets(
  db: Database,
  requests: readonly TargetRequest[],
): Promise<Map<string, ClassifiedTarget[]>> {
  const result = new Map<string, ClassifiedTarget[]>(
    requests.map((request) => [request.key, []]),
  );
  const pairs = requests.flatMap((request, index) =>
    [...new Set(request.ids)].map((id) => ({
      index,
      id,
      kind: request.kind,
      amount: request.amountMinor,
      source: request.owner?.source ?? null,
      charge: request.owner?.chargeKey ?? null,
      current: request.currentTransactionId ?? null,
    })),
  );
  if (!pairs.length) return result;
  const rows = requestedRows(
    pairs,
    {
      index: "int",
      id: "uuid",
      kind: "text",
      amount: "int",
      source: "text",
      charge: "text",
      current: "uuid",
    },
    "r",
  );
  // includes-deleted: retained occurrence and alias history owns its reservation.
  const facts = await unwrapDb(db).execute<{
    index: number;
    id: string;
    void: boolean;
    transfer: boolean;
    amountMinor: string | number | null;
    remainingMinor: string | number | null;
    claimed: boolean;
    owned: boolean;
  }>(
    sql`
    WITH r AS (SELECT * FROM ${rows.from})
    SELECT r.index, p.id, (p."deletedAt" IS NOT NULL) AS void, false AS transfer,
      totals.total AS "amountMinor", totals.total - COALESCE(alloc.total, 0) AS "remainingMinor", false AS claimed, false AS owned
    FROM r JOIN "Purchase" p ON r.kind = ${"purchase"} AND p.id = r.id
    CROSS JOIN LATERAL (SELECT CASE WHEN count(*) = 0 THEN p."statedTotalMinor"
      WHEN bool_or(e.cost IS NULL OR e."lineKind" = ${expenseLineKindSchema.enum.unclassified}) THEN NULL
      ELSE round(sum(e.cost) * 100) END AS total FROM "Expense" e
      WHERE e."purchaseId" = p.id AND ${notDeleted("e")} AND NOT e.future AND e."economicRole" = ${expenseEconomicRoleSchema.enum.vendor}) totals
    CROSS JOIN LATERAL (SELECT sum(a."amountMinor") AS total FROM "FinancialTransactionAllocation" a
      JOIN "FinancialTransaction" t ON t.id = a."transactionId"
      WHERE a."purchaseId" = p.id AND ${notDeleted("a")} AND ${notDeleted("t")}
        AND t.status NOT IN (${financialTransactionStatus.enum.void}, ${financialTransactionStatus.enum.expected}) AND t.id IS DISTINCT FROM r.current
        AND sign(a."amountMinor") = sign(r.amount)) alloc
    UNION ALL
    SELECT r.index, t.id, (t."deletedAt" IS NOT NULL OR t.status = ${financialTransactionStatus.enum.void}), (t."ledgerTransferId" IS NOT NULL),
      t."amountMinor", NULL, (EXISTS (/* includes-deleted: retained occurrence reservations remain authoritative. */ SELECT 1 FROM "SourceOccurrence" o
        WHERE o."acceptedTransactionId" = t.id AND o.source = r.source AND o.shortcode <> r.charge
          AND o.disposition <> ${sourceTransactionRecordDisposition.enum.ignored} AND o."supersededByOccurrenceId" IS NULL)
        OR EXISTS (/* includes-deleted: retained aliases preserve unresolved ownership. */ SELECT 1 FROM "FinancialEvidenceAlias" a LEFT JOIN "SourceOccurrence" retained ON retained.id = a."occurrenceId"
          WHERE a."historicalTransactionId" = t.id AND a.source = r.source
            AND (retained.id IS NULL OR retained."acceptedTransactionId" IS DISTINCT FROM a."historicalTransactionId"))),
      (EXISTS (/* includes-deleted: retained occurrence reservations remain authoritative. */ SELECT 1 FROM "SourceOccurrence" o WHERE o."acceptedTransactionId" = t.id AND o.source <> r.source
        AND o.disposition <> ${sourceTransactionRecordDisposition.enum.ignored} AND o."supersededByOccurrenceId" IS NULL)
       OR EXISTS (/* includes-deleted: retained aliases preserve unresolved ownership. */ SELECT 1 FROM "FinancialEvidenceAlias" a LEFT JOIN "SourceOccurrence" retained ON retained.id = a."occurrenceId"
        WHERE a."historicalTransactionId" = t.id AND a.source <> r.source
          AND (retained.id IS NULL OR retained."acceptedTransactionId" IS DISTINCT FROM a."historicalTransactionId")))
    FROM r JOIN "FinancialTransaction" t ON r.kind = ${"financialTransaction"} AND t.id = r.id
  `,
    "objects",
  );
  for (const fact of facts) {
    const request = requests[Number(fact.index)]!;
    result.get(request.key)!.push(
      classifyTarget(request, {
        ...fact,
        amountMinor:
          fact.amountMinor === null ? null : Number(fact.amountMinor),
        remainingMinor:
          fact.remainingMinor === null ? null : Number(fact.remainingMinor),
      }),
    );
  }
  return result;
}
