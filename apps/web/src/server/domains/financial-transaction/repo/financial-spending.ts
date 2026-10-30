import type { ActorContext } from "@cubby/schemas/context";
import { cardLastFoursOn } from "@cubby/schemas/financial-account";
import {
  FINANCIAL_SPENDING_POLICY,
  financialSpendingAdvice,
  financialBookingInput,
  financialSpendingPlan,
  financialSpendingRequest,
  financialSpendingSource,
  type FinancialSpendingPlan,
} from "@cubby/schemas/financial-booking";
import { financialTransactionSettlementViolation } from "@cubby/schemas/financial-transaction";
import { parseShortcodeFor, parseEntityId } from "@cubby/schemas/identifiers";
import { cents } from "@cubby/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { groupBy } from "es-toolkit";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  databaseForTransaction,
  getDb,
  notDeleted,
  withSnapshotWrite,
} from "~/server/db/helpers";
import {
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  spendingCategory,
  vendor as vendorTable,
} from "~/server/db/schema";
import {
  effectiveExpenseSpendingCategoriesSql,
  effectiveExpenseSpendingCategorySql,
} from "~/server/domains/expense/repo/expense-category-resolution";
import {
  accountPurchaserKey,
  liveHouseholdCard,
  financialAccountPurchaser,
  loadAccountPurchaserProofs,
} from "~/server/domains/financial-account/repo/purchaser";
import { lockFinancialEvidenceKeys } from "~/server/domains/financial-transaction/repo/financial-evidence";
import {
  planPurchaseRetainedSettlement,
  prepareRetainedSettlementDiscovery,
  retainedSettlementDiscoveryCouldMatch,
  settlePurchaseFromRetainedPayments,
} from "~/server/domains/purchase-import/repo/retained-settlement";
import { resolveNames } from "~/server/entity-kernel/resolve";
import { AppError, createAppError } from "~/server/errors/app-error";
import {
  settlementRefsFor,
  settlementRefsIncluding,
  type SettlementRef,
} from "~/server/generic/entity-links/repo/entity-external-ids";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { canonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";

import {
  bookFinancialTransaction,
  bookingGraph,
  bookingGraphs,
  digestValue,
  loadFinancialBookingLineage,
  previewFinancialBooking,
} from "./financial-booking";

function refuse(message: string): never {
  throw createAppError("CONSTRAINT_VIOLATION", message);
}

type Request = z.infer<typeof financialSpendingRequest>;
const spendingRequestBoundary = z.union([
  financialSpendingRequest.extend({
    transactionId: financialSpendingRequest.shape.transactionId.unwrap(),
    source: z.never().optional(),
  }),
  financialSpendingRequest.extend({
    transactionId: z.never().optional(),
    source: financialSpendingSource,
  }),
]);

function spendingBlocker(input: {
  facts: Awaited<ReturnType<typeof spendingFacts>>;
  advice: Request["advice"];
  vendorResolved: boolean;
  ambiguous: boolean;
}) {
  const { facts, advice } = input;
  if (!facts.purchaser && !liveHouseholdCard(facts.account))
    return "A confirmed member-owned account or household credit card is required before booking spending.";
  if (
    !(facts.source.transactionDate ?? facts.source.postedDate) ||
    !facts.source.sourceRefs.length
  )
    return "A dated, stable source identity is required before booking spending.";
  if (input.ambiguous)
    return "The merchant matches competing Vendors; review its identity.";
  if (
    !input.vendorResolved &&
    (!advice?.vendorName ||
      advice.vendorConfidence !== "high" ||
      advice.counterparty !== "business")
  )
    return "The merchant needs a supported business name before a Vendor can be created.";
  if (
    advice?.counterparty === "person" ||
    advice?.counterparty === "payment_processor"
  )
    return "The counterparty does not identify a business Vendor.";
  return null;
}

const resolveSpendingVendors = (db: Database, names: readonly string[]) =>
  resolveNames(
    db,
    "vendor",
    names.map((name) => ({ name })),
    { create: false },
  );

type SpendingCandidate = {
  id: string;
  shortcode: string;
  displayLabel: string | null;
  date: string | null;
  // Additional older spending can stop creation, never authorize settlement.
  reviewOnly?: boolean;
};
type PaymentCandidate = SpendingCandidate & {
  amountKey: string;
  chargedDate: string;
};
type VendorCandidate = SpendingCandidate & { hasVendorSpending: boolean };
const calendarGap = (left: string, right: string) =>
  Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) /
  86_400_000;

/** Read-only metadata for one synchronous proposal page; never reuse at commit or across model work. */
export async function prepareFinancialSpendingPage(
  db: Database,
  input: {
    accountIds: ReadonlyArray<(typeof financialAccount.$inferSelect)["id"]>;
    transactionIds: ReadonlyArray<
      (typeof financialTransaction.$inferSelect)["id"]
    >;
    sources?: readonly {
      amount: number;
      merchant?: string | null;
      rawDescription?: string | null;
      kind?: string;
      transactionDate?: string | null;
      postedDate?: string | null;
    }[];
  },
) {
  const transactions = input.transactionIds.length
    ? await getDb(db).query.financialTransaction.findMany({
        where: and(
          inArray(financialTransaction.id, [...new Set(input.transactionIds)]),
          notDeleted(financialTransaction),
        ),
      })
    : [];
  const accountIds = [
    ...new Set([
      ...input.accountIds,
      ...transactions.map((row) => row.accountId),
    ]),
  ];
  const accounts = accountIds.length
    ? await getDb(db).query.financialAccount.findMany({
        where: and(
          inArray(financialAccount.id, accountIds),
          notDeleted(financialAccount),
        ),
        with: { ledgerParty: true },
      })
    : [];
  const accountsById = new Map<string, (typeof accounts)[number]>(
    accounts.map((row) => [row.id, row]),
  );
  for (const account of accounts) accountsById.set(account.shortcode, account);
  const transactionsById = new Map<string, (typeof transactions)[number]>(
    transactions.map((row) => [row.id, row]),
  );
  for (const transaction of transactions)
    transactionsById.set(transaction.shortcode, transaction);
  const transactionIds = transactions.map((row) => row.id);
  const references = await settlementRefsFor(db, transactionIds);
  const allocations = transactionIds.length
    ? await getDb(db).query.financialTransactionAllocation.findMany({
        where: and(
          inArray(financialTransactionAllocation.transactionId, transactionIds),
          notDeleted(financialTransactionAllocation),
        ),
        orderBy: financialTransactionAllocation.purchaseId,
      })
    : [];
  const allocationsByTransaction = new Map<string, typeof allocations>();
  for (const allocation of allocations) {
    const existing =
      allocationsByTransaction.get(allocation.transactionId) ?? [];
    existing.push(allocation);
    allocationsByTransaction.set(allocation.transactionId, existing);
  }
  const sources = [...(input.sources ?? []), ...transactions];
  const purchaserProofs = await loadAccountPurchaserProofs(
    db,
    accounts.flatMap((account) =>
      financialAccountPurchaser(account, undefined)
        ? []
        : sources.map((source) => ({
            accountId: account.id,
            date: source.transactionDate ?? source.postedDate ?? null,
          })),
    ),
  );
  const dates = sources
    .flatMap((source) => source.transactionDate ?? source.postedDate ?? [])
    .sort();
  const candidateBounds =
    input.sources && dates.length
      ? { first: dates[0]!, last: dates.at(-1)! }
      : null;
  const amounts = [...new Set(sources.map((source) => cents(source.amount)))];
  const paymentCandidates =
    candidateBounds && amounts.length
      ? (
          await getDb(db).execute<PaymentCandidate>(sql`
        SELECT p.id,p.shortcode,p."displayLabel",p.date,
          round(payment.amount * 100)::text AS "amountKey", payment."chargedAt"::date::text AS "chargedDate"
        FROM "PurchasePaymentEvidence" payment JOIN "Purchase" p ON p.id=payment."purchaseId" AND ${notDeleted("p")}
        WHERE round(payment.amount * 100) IN (${sql.join(
          amounts.map((amount) => sql`${amount}`),
          sql`, `,
        )})
          AND payment."chargedAt"::date BETWEEN ${candidateBounds.first}::date-3 AND ${candidateBounds.last}::date+3
        ORDER BY p.id
      `)
        ).rows
      : [];
  const page = {
    sources,
    retainedSettlement: await prepareRetainedSettlementDiscovery(getDb(db), []),
    candidateBounds,
    candidateAmounts: new Set(amounts),
    paymentCandidates: groupBy(paymentCandidates, (row) => row.amountKey),
    vendorCandidates: new Map<string, Promise<VendorCandidate[]>>(),
    explicitCandidates: new Map<string, Promise<SpendingCandidate[]>>(),
    references,
    allocations: allocationsByTransaction,
    accounts: accountsById,
    purchaserProofs,
    transactions: transactionsById,
    // Promise caching coalesces concurrent identical reads without extending
    // their lifetime beyond this advisory page. Commit rebuilds without it.
    vendors: new Map<string, ReturnType<typeof resolveSpendingVendors>>(),
    graphs: new Map<
      Parameters<typeof bookingGraph>[1],
      ReturnType<typeof loadSpendingGraph>
    >(),
    categoryHistory: new Map<
      string,
      ReturnType<typeof financialSpendingCategoryHistory>
    >(),
    payments: new Map<string, ReturnType<typeof purchasePayments>>(),
    categories: new Map<
      string,
      Promise<typeof spendingCategory.$inferSelect | undefined>
    >(),
  };
  const allocatedIds = [...new Set(allocations.map((row) => row.purchaseId))];
  for (const [id, graph] of await loadSpendingGraphs(db, allocatedIds))
    page.graphs.set(id, Promise.resolve(graph));
  return page;
}
export type FinancialSpendingPage = Awaited<
  ReturnType<typeof prepareFinancialSpendingPage>
>;

/** Hydrate the candidate union once; each preview still selects its exact evidence. */
export async function prepareFinancialSpendingCandidates(
  db: Database,
  page: FinancialSpendingPage,
) {
  const names = [
    ...new Set(
      page.sources.flatMap((source) => {
        const name = source.merchant?.trim() || source.rawDescription?.trim();
        return name ? [name] : [];
      }),
    ),
  ];
  const resolved = await resolveSpendingVendors(db, names);
  const byName = new Map(resolved.map((result) => [result.name, result]));
  for (const result of resolved)
    page.vendors.set(canonicalJson([result.name]), Promise.resolve([result]));
  const vendorIds = [
    ...new Set(
      resolved.flatMap((result) => (result.row ? [result.row.id] : [])),
    ),
  ];
  const bounds = page.candidateBounds;
  if (bounds && vendorIds.length) {
    const { rows } = await getDb(db).execute<
      VendorCandidate & { vendorId: string }
    >(sql`
      SELECT p.id,p.shortcode,p."displayLabel",p.date,p."vendorId",
        ${vendorSpendingExists} AS "hasVendorSpending" FROM "Purchase" p
      WHERE ${notDeleted("p")} AND p."vendorId" IN (${sql.join(
        vendorIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
        AND (p.date BETWEEN ${bounds.first}::date-14 AND ${bounds.last}::date+14
          OR ${vendorSpendingExists}) ORDER BY p.id
    `);
    const byVendor = groupBy(rows, (row) => row.vendorId);
    for (const vendorId of vendorIds)
      page.vendorCandidates.set(
        vendorId,
        Promise.resolve(
          (byVendor[vendorId] ?? []).map(
            ({ vendorId: _vendorId, ...row }) => row,
          ),
        ),
      );
  }
  const ids = new Set(
    [...page.allocations.values()].flatMap((rows) =>
      rows.map((row) => row.purchaseId),
    ),
  );
  for (const source of page.sources) {
    const date = source.transactionDate ?? source.postedDate;
    if (!date) continue;
    const name = source.merchant?.trim() || source.rawDescription?.trim();
    const candidates = await spendingCandidates(
      db,
      {
        date,
        amount: cents(source.amount),
        refund: source.kind === "refund",
        vendorId: name ? byName.get(name)?.row?.id : undefined,
      },
      page,
    );
    for (const candidate of candidates)
      ids.add(parseEntityId("purchase", candidate.id));
  }
  page.retainedSettlement = await prepareRetainedSettlementDiscovery(
    getDb(db),
    [...ids],
  );
}

async function spendingFacts(
  db: Database,
  request: Request,
  page?: FinancialSpendingPage,
  projection?: Partial<
    Pick<
      z.infer<typeof financialSpendingSource>,
      "amount" | "status" | "postedDate"
    >
  >,
) {
  const row = request.transactionId
    ? page
      ? page.transactions.get(request.transactionId)
      : await getDb(db).query.financialTransaction.findFirst({
          where: and(
            eq(financialTransaction.shortcode, request.transactionId),
            notDeleted(financialTransaction),
          ),
        })
    : undefined;
  if (request.transactionId && !row)
    refuse("The spending transaction is no longer live.");
  const account = page
    ? page.accounts.get(row?.accountId ?? request.source?.accountId ?? "")
    : await getDb(db).query.financialAccount.findFirst({
        where: row
          ? and(
              eq(financialAccount.id, row.accountId),
              notDeleted(financialAccount),
            )
          : and(
              eq(financialAccount.shortcode, request.source?.accountId ?? ""),
              notDeleted(financialAccount),
            ),
        with: { ledgerParty: true },
      });
  if (!account) refuse("The spending account is no longer live.");
  const source = row
    ? financialSpendingSource.parse({
        ...row,
        ...projection,
        accountId: account.shortcode,
        sourceRefs: page
          ? [...(page.references.get(row.id) ?? [])]
          : ((await settlementRefsFor(db, [row.id])).get(row.id) ?? []),
      })
    : financialSpendingSource.parse(request.source);
  source.sourceRefs.sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.externalId.localeCompare(b.externalId),
  );
  const date = source.transactionDate ?? source.postedDate;
  const purchaserProof = financialAccountPurchaser(account, undefined)
    ? undefined
    : (
        page?.purchaserProofs ??
        (await loadAccountPurchaserProofs(db, [
          { accountId: account.id, date },
        ]))
      ).get(accountPurchaserKey(account.id, date));
  const purchaser = financialAccountPurchaser(account, purchaserProof);
  const allocations = row
    ? page
      ? (page.allocations.get(row.id) ?? [])
      : await getDb(db).query.financialTransactionAllocation.findMany({
          where: and(
            eq(financialTransactionAllocation.transactionId, row.id),
            notDeleted(financialTransactionAllocation),
          ),
          orderBy: financialTransactionAllocation.purchaseId,
        })
    : [];
  const graphs = [];
  for (const allocation of allocations)
    graphs.push(await spendingGraph(db, allocation.purchaseId, page));
  return {
    row,
    source,
    account,
    purchaserProof,
    purchaser,
    allocations,
    graphs,
  };
}

/** Capacity includes other settlements and effective categories, not just a signed line. */
function spendingGraph(
  db: Database,
  purchaseId: NonNullable<Parameters<typeof bookingGraph>[1]>,
  page?: FinancialSpendingPage,
) {
  const cached = page?.graphs.get(purchaseId);
  if (cached) return cached;
  const graph = loadSpendingGraph(db, purchaseId);
  page?.graphs.set(purchaseId, graph);
  return graph;
}

async function loadSpendingGraph(
  db: Database,
  purchaseId: NonNullable<Parameters<typeof bookingGraph>[1]>,
) {
  const graph = (await loadSpendingGraphs(db, [purchaseId])).get(purchaseId);
  if (!graph) return refuse("The selected Purchase is no longer live.");
  return graph;
}

async function loadSpendingGraphs(
  db: Database,
  purchaseIds: readonly NonNullable<Parameters<typeof bookingGraph>[1]>[],
) {
  const ids = [...new Set(purchaseIds)];
  const graphs = await bookingGraphs(db, ids);
  const categories = ids.length
    ? (
        await getDb(db).execute<{
          id: string;
          purchaseId: string;
          category: string | null;
        }>(sql`
    SELECT e.id, e."purchaseId", ${effectiveExpenseSpendingCategorySql("e")} AS category FROM "Expense" e
    WHERE e."purchaseId" IN (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}) AND ${notDeleted("e")} ORDER BY e.id
  `)
      ).rows
    : [];
  const settlements = ids.length
    ? (
        await getDb(db).execute<{
          purchaseId: string;
          transactionId: string;
          transactionCode: string;
          amount: number;
          kind: string;
          status: string;
          deletedAt: string | null;
          ledgerTransferId: string | null;
          transactionAmount: number;
          allocatedAmount: number;
          accountDeletedAt: string | null;
          transaction: unknown;
          account: unknown;
          owner: unknown;
        }>(sql`SELECT a."purchaseId", a."transactionId", f.shortcode AS "transactionCode", a.amount, f.kind, f.status, f."deletedAt", f."ledgerTransferId",
    f.amount AS "transactionAmount", fa."deletedAt" AS "accountDeletedAt",
    (SELECT sum(coverage.amount) FROM "FinancialTransactionAllocation" coverage
      WHERE coverage."transactionId" = f.id AND ${notDeleted("coverage")}) AS "allocatedAmount",
    to_jsonb(f) AS transaction, to_jsonb(fa) AS account, to_jsonb(lp) AS owner
    FROM "FinancialTransactionAllocation" a JOIN "FinancialTransaction" f ON f.id = a."transactionId"
    JOIN "FinancialAccount" fa ON fa.id = f."accountId"
    LEFT JOIN "LedgerParty" lp ON lp.id = fa."ledgerPartyId"
    WHERE a."purchaseId" IN (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}) AND ${notDeleted("a")} ORDER BY a."transactionId", a.id
  `)
      ).rows
    : [];
  const categoriesByPurchase = groupBy(categories, (row) => row.purchaseId);
  const settlementsByPurchase = groupBy(settlements, (row) => row.purchaseId);
  return new Map(
    [...graphs].map(([id, graph]) => [
      id,
      {
        ...graph,
        categories: (categoriesByPurchase[id] ?? []).map(
          ({ purchaseId: _purchaseId, ...row }) => row,
        ),
        settlements: (settlementsByPurchase[id] ?? []).map(
          ({ purchaseId: _purchaseId, ...row }) => row,
        ),
      },
    ]),
  );
}

function availableCents(
  graph: Awaited<ReturnType<typeof spendingGraph>> | undefined,
  amount: number,
  currentId?: string,
) {
  if (!graph) return null;
  const lines = graph.lines.filter(
    (line) => !line.future && line.economicRole === "vendor",
  );
  if (
    !lines.length ||
    lines.some((line) => line.cost === null || line.lineKind === "unclassified")
  )
    return null;
  const matching = lines.filter((line) =>
    amount < 0
      ? line.cost !== null && line.cost < 0 && line.lineKind === "principal"
      : line.cost !== null && (line.cost >= 0 || line.lineKind !== "principal"),
  );
  const reimbursements = new Set(
    graph.lines
      .filter((line) => line.economicRole === "reimbursement")
      .map((line) => line.bookingTransactionCode),
  );
  const other = graph.settlements.filter(
    (entry) =>
      entry.transactionId !== currentId &&
      entry.kind !== "income" &&
      !reimbursements.has(entry.transactionCode) &&
      Math.sign(Number(entry.amount)) === Math.sign(amount),
  );
  if (
    other.some(
      (entry) =>
        entry.deletedAt ||
        entry.accountDeletedAt ||
        entry.status === "void" ||
        entry.status === "expected" ||
        entry.ledgerTransferId ||
        !["purchase", "fee", "refund"].includes(entry.kind) ||
        cents(Number(entry.allocatedAmount)) !==
          cents(Number(entry.transactionAmount)) ||
        Math.sign(Number(entry.amount)) !==
          Math.sign(Number(entry.transactionAmount)),
    )
  )
    return null;
  return (
    matching.reduce((sum, line) => sum + cents(line.cost ?? 0), 0) -
    other.reduce((sum, entry) => sum + cents(Number(entry.amount)), 0)
  );
}

export async function financialSpendingCategoryHistory(
  db: Database,
  vendorId: string,
) {
  return (
    await getDb(db).execute<{
      category: string | null;
      name: string | null;
      lines: number;
    }>(sql`
    WITH selected_expenses AS (
      SELECT e.id, e."purchaseId", e."productId", e."spendingCategoryId", e."lineKind"
      FROM "Expense" e JOIN "Purchase" p ON p.id=e."purchaseId"
      WHERE p."vendorId"=${vendorId} AND ${notDeleted("p")} AND ${notDeleted("e")} AND NOT e.future
    ), resolved AS (
      ${effectiveExpenseSpendingCategoriesSql(sql`selected_expenses`)}
    )
    SELECT r."spendingCategoryId" AS category, c.name, count(*)::int AS lines
    FROM resolved r
    LEFT JOIN "SpendingCategory" c ON c.id=r."spendingCategoryId" AND ${notDeleted("c")}
    GROUP BY r."spendingCategoryId", c.name ORDER BY category NULLS FIRST
  `)
  ).rows;
}

function reviewedSpendingAdvice(request: Request) {
  if (!request.reviewedVendorName && !request.spendingCategoryId)
    return request.advice;
  return financialSpendingAdvice.parse({
    ...request.advice,
    ...(request.reviewedVendorName && {
      vendorName: request.reviewedVendorName,
      vendorConfidence: "high",
      counterparty: "business",
    }),
    ...(request.spendingCategoryId && {
      spendingCategoryId: request.spendingCategoryId,
      categoryConfidence: "high",
    }),
  });
}

export function resolveFinancialSpendingVendors(
  db: Database,
  names: readonly string[],
  page?: Pick<FinancialSpendingPage, "vendors">,
) {
  const key = canonicalJson([...names]);
  const cached = page?.vendors.get(key);
  if (cached) return cached;
  const lookup = names.length
    ? resolveSpendingVendors(db, names)
    : Promise.resolve([]);
  page?.vendors.set(key, lookup);
  return lookup;
}

async function purchasePayments(db: Database, purchaseId: string) {
  return (
    await getDb(db).execute(
      sql`SELECT * FROM "PurchasePaymentEvidence" WHERE "purchaseId" = ${purchaseId} ORDER BY id`,
    )
  ).rows;
}

function spendingPayments(
  db: Database,
  purchaseId: string,
  page?: FinancialSpendingPage,
) {
  const cached = page?.payments.get(purchaseId);
  if (cached) return cached;
  const payments = purchasePayments(db, purchaseId);
  page?.payments.set(purchaseId, payments);
  return payments;
}

type CandidateInput = {
  date: string;
  amount: number;
  refund: boolean;
  vendorId?: string;
  purchaseId?: string | null;
};

// A header total is not spending. Unknown costs on actual vendor lines still
// require graph review; neither amount equality nor an order date is required.
const vendorSpendingExists = sql`EXISTS (
  SELECT 1 FROM "Expense" e WHERE e."purchaseId" = p.id
    AND ${notDeleted("e")} AND NOT e.future
    AND e."economicRole" = ${financialBookingInput.shape.economicRole.unwrap().enum.vendor}
)`;
async function spendingCandidates(
  db: Database,
  input: CandidateInput,
  page?: FinancialSpendingPage,
): Promise<SpendingCandidate[]> {
  const bounds = page?.candidateBounds;
  // The page pool is a superset only for the source dates admitted at construction.
  // Other callers keep the exact fresh selector, including all commit previews.
  if (
    !page ||
    !bounds ||
    !page.candidateAmounts.has(input.amount) ||
    input.date < bounds.first ||
    input.date > bounds.last
  ) {
    const original = sql`(p.shortcode = ${input.purchaseId ?? null}
      OR (p."vendorId" = ${input.vendorId ?? null}::uuid AND ${!input.refund}
        AND abs(p.date - ${input.date}::date) <= 14)
      OR EXISTS (SELECT 1 FROM "PurchasePaymentEvidence" payment
        WHERE payment."purchaseId" = p.id
          AND round(payment.amount * 100) = ${input.amount}
          AND abs(payment."chargedAt"::date - ${input.date}::date) <= 3))`;
    return (
      await getDb(db)
        .execute<SpendingCandidate>(sql`SELECT p.id, p.shortcode, p."displayLabel", p.date,
          NOT COALESCE(${original}, false) AS "reviewOnly" FROM "Purchase" p
    WHERE ${notDeleted("p")}
      AND (${original} OR (p."vendorId" = ${input.vendorId ?? null}::uuid
        AND ${!input.refund} AND ${vendorSpendingExists}))
    ORDER BY p.id`)
    ).rows;
  }
  const candidates = new Map<string, SpendingCandidate>();
  for (const candidate of page.paymentCandidates[String(input.amount)] ?? []) {
    if (calendarGap(candidate.chargedDate, input.date) <= 3)
      candidates.set(candidate.id, {
        id: candidate.id,
        shortcode: candidate.shortcode,
        displayLabel: candidate.displayLabel,
        date: candidate.date,
        reviewOnly: false,
      });
  }
  if (input.vendorId && !input.refund) {
    let lookup = page.vendorCandidates.get(input.vendorId);
    if (!lookup) {
      lookup = getDb(db)
        .execute<VendorCandidate>(sql`SELECT p.id,p.shortcode,p."displayLabel",p.date,
          ${vendorSpendingExists} AS "hasVendorSpending" FROM "Purchase" p
        WHERE ${notDeleted("p")} AND p."vendorId"=${input.vendorId}::uuid
          AND (p.date BETWEEN ${bounds.first}::date-14 AND ${bounds.last}::date+14
            OR ${vendorSpendingExists}) ORDER BY p.id`)
        .then((result) => result.rows);
      page.vendorCandidates.set(input.vendorId, lookup);
    }
    for (const { hasVendorSpending, ...candidate } of await lookup) {
      const nearby = Boolean(
        candidate.date && calendarGap(candidate.date, input.date) <= 14,
      );
      // The page pool also contains date-window headers for other source dates.
      // Only actual spending belongs to the additional review-only selector.
      if (!nearby && !hasVendorSpending) continue;
      if (!candidates.has(candidate.id))
        candidates.set(candidate.id, { ...candidate, reviewOnly: !nearby });
    }
  }
  if (input.purchaseId) {
    let lookup = page.explicitCandidates.get(input.purchaseId);
    if (!lookup) {
      lookup = getDb(db)
        .execute<SpendingCandidate>(sql`SELECT p.id,p.shortcode,p."displayLabel",p.date FROM "Purchase" p
        WHERE ${notDeleted("p")} AND p.shortcode=${input.purchaseId} ORDER BY p.id`)
        .then((result) => result.rows);
      page.explicitCandidates.set(input.purchaseId, lookup);
    }
    for (const candidate of await lookup)
      candidates.set(candidate.id, { ...candidate, reviewOnly: false });
  }
  return [...candidates.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function canReadBookingCandidates(
  input: Parameters<typeof spendingBlocker>[0],
) {
  return (
    input.facts.source.kind === "refund" || spendingBlocker(input) === null
  );
}

function candidateGraphInputs(
  candidates: readonly SpendingCandidate[],
  input: Parameters<typeof spendingBlocker>[0],
) {
  return canReadBookingCandidates(input) ? candidates : [];
}

async function categoryHistoryForDiscovery(
  db: Database,
  vendorId: string | undefined,
  input: Parameters<typeof spendingBlocker>[0],
  page?: FinancialSpendingPage,
) {
  // Uncertain classification leaves spending uncategorized; history still
  // determines whether category advice can be applied without guessing.
  if (!vendorId || !canReadBookingCandidates(input)) return [];
  const lookup =
    page?.categoryHistory.get(vendorId) ??
    financialSpendingCategoryHistory(db, vendorId);
  page?.categoryHistory.set(vendorId, lookup);
  return lookup;
}

function spendingCategoryForDiscovery(
  db: Database,
  reference:
    | { id: (typeof spendingCategory.$inferSelect)["id"] }
    | { shortcode: string },
  page?: FinancialSpendingPage,
) {
  const key =
    "id" in reference
      ? `id:${reference.id}`
      : `shortcode:${reference.shortcode}`;
  const cached = page?.categories.get(key);
  if (cached) return cached;
  // Coalesce concurrent advisory reads, including misses. Commit has no page.
  const lookup = getDb(db)
    .query.spendingCategory.findFirst({
      where: and(
        "id" in reference
          ? eq(spendingCategory.id, reference.id)
          : eq(spendingCategory.shortcode, reference.shortcode),
        notDeleted(spendingCategory),
      ),
    })
    .then((row) => row);
  page?.categories.set(key, lookup);
  return lookup;
}

/** Discovery does not authorize a write; the same retained evidence is rebuilt at commit. */
async function discoverSpendingEvidence(
  db: Database,
  request: Request,
  facts: Awaited<ReturnType<typeof spendingFacts>>,
  page?: FinancialSpendingPage,
) {
  const { row, source, account, allocations, graphs } = facts;
  let advice = reviewedSpendingAdvice(request);
  const names = [
    ...new Set(
      [
        source.merchant?.trim() || source.rawDescription?.trim(),
        advice?.vendorName,
      ].filter((value): value is string => Boolean(value)),
    ),
  ];
  const resolved = await resolveFinancialSpendingVendors(db, names, page);
  const vendors = new Map(
    resolved.flatMap((result) =>
      result.row ? [[result.row.id, result.row] as const] : [],
    ),
  );
  const ambiguous =
    vendors.size > 1 ||
    resolved.some((result) =>
      result.candidates.some((candidate) => !vendors.has(candidate.id)),
    );
  const selectedVendor = request.vendorId
    ? await getDb(db).query.vendor.findFirst({
        where: and(
          eq(vendorTable.shortcode, request.vendorId),
          notDeleted(vendorTable),
        ),
      })
    : undefined;
  const vendor =
    selectedVendor ??
    (vendors.size === 1 ? [...vendors.values()][0] : undefined);
  let category = advice?.spendingCategoryId
    ? await spendingCategoryForDiscovery(
        db,
        { shortcode: advice.spendingCategoryId },
        page,
      )
    : undefined;
  const date = source.transactionDate ?? source.postedDate;
  // Retained payment dates use UTC calendar days, matching the shared matcher.
  const candidates = date
    ? await spendingCandidates(
        db,
        {
          date,
          amount: cents(source.amount),
          refund: source.kind === "refund",
          vendorId: vendor?.id,
          purchaseId: request.purchaseId,
        },
        page,
      )
    : [];
  const rejected = new Set(request.rejectedPurchaseIds);
  const unrejectedCandidates = candidates.filter(
    (candidate) =>
      !rejected.has(parseShortcodeFor("purchase", candidate.shortcode)),
  );
  const strong = new Map<
    string,
    Awaited<ReturnType<typeof planPurchaseRetainedSettlement>>
  >();
  if (
    date &&
    account.ledgerPartyId &&
    source.status !== "void" &&
    source.status !== "expected" &&
    ["purchase", "fee", "refund"].includes(source.kind)
  ) {
    // UTC noon carries a plain calendar date to the retained-payment matcher.
    const charge = {
      id: row?.id ?? "prospective",
      accountId: account.id,
      kind: source.kind,
      amount: source.amount,
      occurredAt: new Date(`${date}T12:00:00.000Z`),
      cardLastFours: cardLastFoursOn(account.cardNumbers, date),
      storedValue: account.identity.kind === "stored_value",
    };
    const retained =
      page?.retainedSettlement ??
      (await prepareRetainedSettlementDiscovery(
        getDb(db),
        unrejectedCandidates
          .filter((candidate) => !candidate.reviewOnly)
          .map((candidate) => parseEntityId("purchase", candidate.id)),
      ));
    for (const candidate of unrejectedCandidates) {
      if (candidate.reviewOnly) continue;
      const purchaseId = parseEntityId("purchase", candidate.id);
      const facts = retained.get(purchaseId);
      if (!retainedSettlementDiscoveryCouldMatch(facts, charge, Boolean(row)))
        continue;
      const plan = await planPurchaseRetainedSettlement(
        getDb(db),
        {
          purchaseId,
          ledgerPartyId: account.ledgerPartyId!,
          additionalCharges: [charge],
          discovery: true,
        },
        retained,
      );
      if (
        Array.isArray(plan) &&
        plan.some((entry) => entry.charge.id === charge.id)
      )
        strong.set(candidate.shortcode, plan);
    }
  }
  const history = await categoryHistoryForDiscovery(
    db,
    vendor?.id,
    {
      facts,
      advice,
      vendorResolved: Boolean(vendor),
      ambiguous: ambiguous && !request.vendorId,
    },
    page,
  );
  // Review-only plans cannot be committed. Load receipt graphs only once
  // identity can admit booking, or a refund needs its original category.
  const graphCandidates = candidateGraphInputs(unrejectedCandidates, {
    facts,
    advice,
    vendorResolved: Boolean(vendor),
    ambiguous: ambiguous && !request.vendorId,
  });
  const uncachedIds = graphCandidates
    .map((candidate) => parseEntityId("purchase", candidate.id))
    .filter((id) => !page?.graphs.has(id));
  const loadedGraphs = await loadSpendingGraphs(db, uncachedIds);
  loadedGraphs.forEach((graph, id) => {
    page?.graphs.set(id, Promise.resolve(graph));
  });
  const candidateEvidence = await Promise.all(
    graphCandidates.map(async (candidate) => ({
      ...candidate,
      graph:
        loadedGraphs.get(parseEntityId("purchase", candidate.id)) ??
        (await spendingGraph(
          db,
          parseEntityId("purchase", candidate.id),
          page,
        )),
      payments: candidate.reviewOnly
        ? []
        : await spendingPayments(db, candidate.id, page),
      plan: strong.get(candidate.shortcode) ?? null,
    })),
  );
  const candidateGraphs = new Map(
    candidateEvidence.map((candidate) => [candidate.id, candidate.graph]),
  );
  const liveCandidates = unrejectedCandidates.filter((candidate) => {
    if (!candidate.reviewOnly) return true;
    const graph = candidateGraphs.get(candidate.id);
    // Only confidently exhausted capacity removes an added-only blocker.
    // Unknown and negative capacity cannot establish ordinary full settlement.
    return availableCents(graph, source.amount, row?.id) !== 0;
  });
  let categoryFromPurchase = false;
  if (source.kind === "refund" && !request.spendingCategoryId) {
    const original = request.purchaseId
      ? candidateEvidence.find(
          (candidate) => candidate.shortcode === request.purchaseId,
        )
      : strong.size === 1
        ? candidateEvidence.find((candidate) => strong.has(candidate.shortcode))
        : undefined;
    if (original) {
      const eligibleLines = original.graph.lines.filter(
        (line) => !line.future && line.economicRole === "vendor",
      );
      const negative = eligibleLines.filter(
        (line) =>
          line.cost !== null && line.cost < 0 && line.lineKind === "principal",
      );
      const lines = negative.length
        ? negative
        : eligibleLines.filter((line) => line.cost !== null && line.cost > 0);
      const categories = new Set(
        lines.map(
          (line) =>
            original.graph.categories.find((entry) => entry.id === line.id)
              ?.category ?? null,
        ),
      );
      const [categoryId] = categories;
      if (categories.size === 1 && categoryId) {
        const inherited = await spendingCategoryForDiscovery(
          db,
          { id: parseEntityId("spendingCategory", categoryId) },
          page,
        );
        if (inherited) {
          category = inherited;
          advice = financialSpendingAdvice.parse({
            ...advice,
            spendingCategoryId: inherited.shortcode,
            categoryConfidence: "high",
            historyConflict: false,
          });
          categoryFromPurchase = true;
        }
      }
    }
  }
  const snapshotEvidence = {
    policy: FINANCIAL_SPENDING_POLICY,
    source,
    advice,
    purchaserProof: facts.purchaserProof,
    account: {
      ...account,
      createdAt: undefined,
      updatedAt: undefined,
      ledgerParty: account.ledgerParty
        ? { ...account.ledgerParty, createdAt: undefined, updatedAt: undefined }
        : null,
    },
    resolved,
    selectedVendor,
    category,
    history,
    reviewedSelection: {
      vendorId: request.vendorId,
      categoryHistoryReviewed: request.categoryHistoryReviewed,
      purchaseId: request.purchaseId,
      rejectedPurchaseIds: [...request.rejectedPurchaseIds].sort(),
    },
    candidates: candidateEvidence.map((candidate) => ({
      ...candidate,
      plan: Array.isArray(candidate.plan)
        ? candidate.plan.map((entry) => ({
            ...entry,
            charge: {
              ...entry.charge,
              id:
                entry.charge.id === (row?.id ?? "prospective")
                  ? "current"
                  : entry.charge.id,
            },
          }))
        : candidate.plan,
    })),
    allocations,
    graphs,
    transactionState: {
      ledgerTransferId: row?.ledgerTransferId ?? null,
      bookingDecisionFingerprint: row?.bookingDecisionFingerprint ?? null,
      bookingExpenseFingerprint: row?.bookingExpenseFingerprint ?? null,
      spendingCategoryId: row?.spendingCategoryId ?? null,
    },
  };
  const snapshot = await digestValue({
    evidence: canonicalJson(jsonSnapshot.parse(snapshotEvidence)),
  });
  const basis = {
    request,
    snapshot,
    candidates: liveCandidates.map((candidate) => ({
      purchaseId: parseShortcodeFor("purchase", candidate.shortcode),
      name: candidate.displayLabel ?? candidate.shortcode,
      strength: strong.has(candidate.shortcode)
        ? ("strong" as const)
        : ("weak" as const),
    })),
  };
  return {
    facts,
    advice,
    category,
    categoryFromPurchase,
    history,
    vendor,
    ambiguous,
    liveCandidates,
    strong,
    candidateEvidence,
    basis,
  };
}

async function existingSpendingOutcome(
  db: Database,
  {
    facts,
    basis,
  }: {
    facts: Awaited<ReturnType<typeof spendingFacts>>;
    basis: Pick<FinancialSpendingPlan, "request" | "snapshot" | "candidates">;
  },
): Promise<FinancialSpendingPlan | null> {
  const { row, source, allocations, graphs } = facts;
  const review = (reason: string): FinancialSpendingPlan => ({
    ...basis,
    status: "review_required",
    reason,
  });
  if (allocations.length) {
    const complete =
      cents(
        allocations.reduce((sum, allocation) => sum + allocation.amount, 0),
      ) === cents(source.amount);
    const booked = graphs.every((graph) => {
      const allocation = allocations.find(
        (entry) => entry.purchaseId === graph.target?.id,
      );
      return (
        allocation &&
        Math.sign(allocation.amount) === Math.sign(source.amount) &&
        availableCents(graph, source.amount, row?.id) ===
          cents(allocation.amount)
      );
    });
    if (
      row?.bookingExpenseFingerprint &&
      row.bookingExpenseFingerprint !==
        (await digestValue(
          await loadFinancialBookingLineage(
            db,
            parseShortcodeFor("financialTransaction", row.shortcode),
          ),
        ))
    )
      return review(
        "The booking lineage changed; reconcile the existing Expenses.",
      );
    if (complete && booked)
      return {
        ...basis,
        status: "already_booked",
        purchaseIds: graphs.flatMap((graph) =>
          graph.target
            ? [parseShortcodeFor("purchase", graph.target.shortcode)]
            : [],
        ),
      };
    return review(
      "Existing allocations need reconciliation before booking more spending.",
    );
  }
  return null;
}

export async function previewFinancialSpending(
  db: Database,
  raw: z.input<typeof financialSpendingRequest>,
  attachment?: {
    settlementRef: SettlementRef;
    fields?: Partial<
      Pick<
        z.infer<typeof financialSpendingSource>,
        "amount" | "status" | "postedDate"
      >
    >;
  },
  page?: FinancialSpendingPage,
): Promise<FinancialSpendingPlan> {
  const request = spendingRequestBoundary.parse(raw);
  const facts = await spendingFacts(db, request, page, attachment?.fields);
  // Preview an impending reference attachment without duplicating its charge.
  // Commit still requires that reference to exist in retained evidence.
  if (attachment && facts.row) {
    facts.source.sourceRefs = await settlementRefsIncluding(
      db,
      facts.row.id,
      attachment.settlementRef,
    );
  }
  const deferred =
    facts.source.status === "void" ||
    facts.source.status === "expected" ||
    facts.row?.ledgerTransferId ||
    !["purchase", "refund", "fee"].includes(facts.source.kind);
  if (deferred || facts.allocations.length) {
    const basis = {
      request,
      candidates: [],
      snapshot: await digestValue({
        evidence: canonicalJson(jsonSnapshot.parse(facts)),
      }),
    };
    if (deferred)
      return {
        ...basis,
        status: "deferred",
        reason:
          "Only observed purchase, fee and refund evidence books spending.",
      };
    const existing = await existingSpendingOutcome(db, { facts, basis });
    if (existing) return existing;
  }
  const evidence = await discoverSpendingEvidence(db, request, facts, page);
  const {
    facts: currentFacts,
    advice,
    category,
    history,
    vendor,
    ambiguous,
    liveCandidates,
    strong,
    candidateEvidence,
    basis,
  } = evidence;
  const { source } = currentFacts;
  const review = (reason: string): FinancialSpendingPlan => ({
    ...basis,
    status: "review_required",
    reason,
  });
  const violation = financialTransactionSettlementViolation({
    linked: true,
    kind: source.kind,
    amount: source.amount,
  });
  if (violation || source.amount === 0)
    return review(violation?.message ?? "Spending must have a nonzero amount.");
  if (request.vendorId && vendor?.shortcode !== request.vendorId)
    return review("The reviewed Vendor is no longer live.");
  if (request.spendingCategoryId) {
    if (!category)
      return review("The reviewed spending category is no longer live.");
    if (
      !request.categoryHistoryReviewed &&
      (advice?.historyConflict ||
        history.some(
          (entry) => entry.category !== null && entry.category !== category.id,
        ))
    )
      return review(
        "Merchant spending history conflicts with the reviewed category.",
      );
  }
  const blocker = spendingBlocker({
    facts: currentFacts,
    advice,
    vendorResolved: Boolean(vendor),
    ambiguous: ambiguous && !request.vendorId,
  });
  if (blocker) return review(blocker);
  const chosen = request.purchaseId
    ? liveCandidates.find(
        (candidate) => candidate.shortcode === request.purchaseId,
      )
    : undefined;
  if (request.purchaseId && !chosen)
    return review("The chosen Purchase is no longer a candidate.");
  const strongTargets = liveCandidates.filter((candidate) =>
    strong.has(candidate.shortcode),
  );
  if (
    source.kind === "refund" &&
    !chosen &&
    !strongTargets.length &&
    request.purchaseId !== null
  )
    return review("Identify the original Purchase before booking this refund.");
  if (
    !chosen &&
    liveCandidates.length &&
    (strongTargets.length !== liveCandidates.length || !strongTargets.length)
  )
    return review(
      "Possible existing Purchases require review before creating more spending.",
    );
  const signatures = new Set(
    strongTargets.map((candidate) =>
      JSON.stringify(strong.get(candidate.shortcode)),
    ),
  );
  if (!chosen && signatures.size > 1)
    return review("Competing complete settlement groups require review.");
  if (
    !chosen &&
    strongTargets.some(
      (candidate) =>
        candidateEvidence.find((entry) => entry.id === candidate.id)?.graph
          .target?.vendorId !== vendor?.id,
    )
  )
    return review(
      "Retained payment evidence names another Vendor; review the Purchase identity before booking.",
    );
  const target = chosen ?? strongTargets[0];
  return prepareReadySpending(db, evidence, target, Boolean(chosen));
}

async function prepareReadySpending(
  db: Database,
  evidence: Awaited<ReturnType<typeof discoverSpendingEvidence>>,
  target:
    | Awaited<
        ReturnType<typeof discoverSpendingEvidence>
      >["liveCandidates"][number]
    | undefined,
  chosen: boolean,
): Promise<FinancialSpendingPlan> {
  const { facts, category, vendor, advice, candidateEvidence, strong, basis } =
    evidence;
  const { row, source } = facts;
  // Category uncertainty must not invent a classification or prevent otherwise
  // supported spending. Missing effective categories enter the existing Work queue.
  const bookingCategory =
    category &&
    advice?.categoryConfidence === "high" &&
    (evidence.categoryFromPurchase ||
      basis.request.categoryHistoryReviewed ||
      (!advice.historyConflict &&
        evidence.history.every(
          (entry) => entry.category === null || entry.category === category.id,
        )))
      ? category
      : undefined;
  const review = (reason: string): FinancialSpendingPlan => ({
    ...basis,
    status: "review_required",
    reason,
  });
  let effect: Extract<FinancialSpendingPlan, { status: "ready" }>["effect"] =
    "create_aggregate";
  if (target) {
    if (!chosen && source.amount > 0) {
      effect = "settle_existing";
      const plan = strong.get(target.shortcode);
      if (!Array.isArray(plan))
        return review("The retained settlement is incomplete.");
      const required = new Map<string, number>();
      for (const entry of plan)
        for (const allocation of entry.next)
          required.set(
            allocation.purchaseId,
            (required.get(allocation.purchaseId) ?? 0) +
              cents(allocation.amount),
          );
      for (const [purchaseId, amount] of required) {
        const candidate = candidateEvidence.find(
          (entry) => entry.id === purchaseId,
        );
        if (
          !candidate ||
          availableCents(candidate.graph, source.amount) !== amount
        )
          return review(
            "The retained payment set does not exactly cover existing priced spending.",
          );
      }
    } else {
      const candidate = candidateEvidence.find(
        (entry) => entry.id === target.id,
      );
      if (!candidate?.graph.target)
        return review("The selected Purchase is no longer live.");
      const empty = candidate.graph.lines.length === 0;
      const available = empty
        ? 0
        : availableCents(candidate.graph, source.amount);
      if (available === cents(source.amount)) effect = "link_existing";
      else if (source.amount > 0) {
        if (
          !empty ||
          candidate.graph.settlements.length ||
          (candidate.graph.target.statedTotal !== null &&
            cents(candidate.graph.target.statedTotal) !== cents(source.amount))
        )
          return review(
            "Review existing spending and settlement capacity before linking this payment.",
          );
      } else if (available !== 0)
        return review(
          "Review existing refund capacity before linking this credit.",
        );
      if (row) {
        try {
          const checked = await previewFinancialBooking(
            db,
            financialBookingInput.parse({
              transactionId: row.shortcode,
              purchaseId: target.shortcode,
              spendingCategoryId: bookingCategory?.shortcode,
            }),
            {
              amount: source.amount,
              status: source.status,
              postedDate: source.postedDate,
            },
          );
          if (checked.action !== effect)
            return review("The selected Purchase's booking capacity changed.");
        } catch (error) {
          if (
            error instanceof AppError &&
            error.reason === "CONSTRAINT_VIOLATION"
          )
            return review(error.message);
          throw error;
        }
      }
    }
  }
  return financialSpendingPlan.parse({
    ...basis,
    status: "ready",
    effect,
    purchaserId: facts.purchaser?.shortcode ?? null,
    purchaserSnapshot: await digestValue({
      account: facts.account,
      purchaserProof: facts.purchaserProof,
    }),
    vendorId: vendor?.shortcode ?? null,
    vendorName: vendor?.name ?? advice!.vendorName,
    spendingCategoryId: bookingCategory?.shortcode ?? null,
    purchaseId: target?.shortcode ?? null,
  });
}

/** The outer caller owns a single serializable retry spanning evidence and all effects. */
export async function commitFinancialSpending(
  db: Database,
  plan: FinancialSpendingPlan,
  actor: ActorContext,
  transactionId = plan.request.transactionId,
) {
  if (plan.status === "review_required")
    return refuse(`Spending needs review: ${plan.reason}`);
  if (plan.status === "deferred") return null;
  if (plan.status === "ready" && !plan.purchaserSnapshot)
    return refuse(
      "Spending purchaser proof is missing; refresh the booking and review again.",
    );
  if (!transactionId)
    return refuse(
      "Create the financial transaction before applying its spending plan.",
    );
  return withSnapshotWrite(
    db,
    async (tx) => {
      const txDb = databaseForTransaction(tx);
      await lockFinancialEvidenceKeys(tx, "reviewed-booking", [transactionId]);
      const fresh = await previewFinancialSpending(txDb, {
        ...plan.request,
        source: undefined,
        transactionId,
      });
      if (fresh.status === "already_booked") {
        const facts = await spendingFacts(txDb, fresh.request);
        if (
          plan.status === "already_booked" &&
          plan.snapshot !== fresh.snapshot
        )
          return refuse(
            "Booked spending evidence changed; review its identity again.",
          );
        if (plan.status === "ready") {
          const [identity] = await resolveNames(
            txDb,
            "vendor",
            [{ name: plan.vendorName }],
            { create: false },
          );
          const acceptedVendor = plan.vendorId
            ? await getDb(txDb).query.vendor.findFirst({
                where: and(
                  eq(vendorTable.shortcode, plan.vendorId),
                  notDeleted(vendorTable),
                ),
              })
            : identity?.row;
          if (
            (facts.purchaser?.shortcode ?? null) !== plan.purchaserId ||
            plan.purchaserSnapshot !==
              (await digestValue({
                account: facts.account,
                purchaserProof: facts.purchaserProof,
              })) ||
            !acceptedVendor ||
            facts.graphs.some(
              (graph) =>
                !graph.target || graph.target.vendorId !== acceptedVendor.id,
            ) ||
            (plan.purchaseId && !fresh.purchaseIds.includes(plan.purchaseId))
          )
            return refuse(
              "The accepted spending identity changed; review its purchaser authority and Purchase Vendor.",
            );
        }
        return { purchaseIds: fresh.purchaseIds, replayed: true };
      }
      if (fresh.status !== "ready" || fresh.snapshot !== plan.snapshot)
        return refuse(
          "Spending evidence changed; refresh the booking and review again.",
        );
      const facts = await spendingFacts(txDb, fresh.request);
      if (fresh.effect === "settle_existing" && fresh.purchaseId) {
        const purchaseId = await resolveOrThrow(
          txDb,
          "purchase",
          fresh.purchaseId,
        );
        const result = await settlePurchaseFromRetainedPayments(tx, {
          purchaseId,
          ledgerPartyId: facts.account.ledgerPartyId!,
          actor,
        });
        if (result !== "allocated")
          return refuse(`Retained settlement needs review: ${result}`);
        const booked = await previewFinancialSpending(txDb, fresh.request);
        if (booked.status !== "already_booked")
          return refuse(
            "Retained settlement did not establish booked spending; review its Expenses.",
          );
        return { purchaseIds: booked.purchaseIds, replayed: false };
      }
      const merchant =
        facts.source.merchant?.trim() || facts.source.rawDescription?.trim();
      const names = [
        ...new Set(
          [merchant, fresh.vendorName].filter((value): value is string =>
            Boolean(value),
          ),
        ),
      ];
      const checked = await resolveNames(
        txDb,
        "vendor",
        names.map((name) => ({ name })),
        { create: false },
      );
      if (
        !fresh.request.vendorId &&
        checked.some(
          (result) =>
            (result.row && result.row.shortcode !== fresh.vendorId) ||
            result.candidates.some(
              (candidate) => candidate.shortcode !== fresh.vendorId,
            ),
        )
      )
        return refuse(
          "The raw or cleaned Vendor identity changed before booking.",
        );
      const selectedVendor = fresh.request.vendorId
        ? await getDb(txDb).query.vendor.findFirst({
            where: and(
              eq(vendorTable.shortcode, fresh.request.vendorId),
              notDeleted(vendorTable),
            ),
          })
        : undefined;
      const [resolved] = selectedVendor
        ? [{ row: selectedVendor, candidates: [] }]
        : fresh.vendorId
          ? checked.filter((result) => result.row?.shortcode === fresh.vendorId)
          : await resolveNames(
              txDb,
              "vendor",
              [
                {
                  name: fresh.vendorName,
                  values: async () => ({
                    aliases:
                      merchant && merchant !== fresh.vendorName
                        ? [merchant]
                        : [],
                  }),
                },
              ],
              { create: true, actor },
            );
      if (!resolved?.row || resolved.candidates.length)
        return refuse("The Vendor identity changed before booking.");
      const booked = await bookFinancialTransaction(
        txDb,
        financialBookingInput.parse({
          transactionId,
          purchaseId: fresh.purchaseId,
          vendorId: resolved.row.shortcode,
          spendingCategoryId: fresh.spendingCategoryId,
          purchaserId: fresh.purchaserId,
          costType: facts.source.kind === "fee" ? "services" : "materials",
        }),
        actor,
      );
      return { purchaseIds: [booked.purchaseId], replayed: booked.replayed };
    },
    { isolationLevel: "serializable" },
  );
}
