import type { ActorContext } from "@cubby/schemas/context";
import { cardLastFoursOn } from "@cubby/schemas/financial-account";
import {
  FINANCIAL_SPENDING_POLICY,
  financialSpendingAdvice,
  financialBookingInput,
  financialSpendingPlan,
  financialSpendingRequest,
  financialSpendingSource,
  financialSpendingCostType,
  type FinancialSpendingPlan,
} from "@cubby/schemas/financial-booking";
import { financialTransactionSettlementViolation } from "@cubby/schemas/financial-transaction";
import {
  financialTransactionStatus,
  type FinancialTransactionSourceRef,
} from "@cubby/schemas/financial-transaction-fields";
import {
  type FinancialTransactionShortcode,
  parseShortcodeFor,
  parseEntityId,
  type VendorId,
  type VendorShortcode,
} from "@cubby/schemas/identifiers";
import { sourceOccurrenceIdentityKind } from "@cubby/schemas/source-occurrence-fields";
import { sourceTransactionRecordDisposition } from "@cubby/schemas/source-transaction-record-fields";
import { moneyToMinor, cents } from "@cubby/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { groupBy, uniq } from "es-toolkit";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { advisoryXactLocks } from "~/server/db/advisory-lock";
import { minorToDollarsSql } from "~/server/db/computed/money";
import {
  databaseForTransaction,
  getDb,
  notDeleted,
  withSnapshotWrite,
} from "~/server/db/helpers";
import {
  columnArrayParam,
  textArrayParam,
  uuidArrayParam,
} from "~/server/db/helpers/query";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import { requestedRows } from "~/server/db/helpers/requested";
import {
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  purchasePaymentEvidence,
  spendingCategory,
  vendor as vendorTable,
} from "~/server/db/schema";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import { readExpenseAttributionParties } from "~/server/domains/expense/repo/expense-attribution";
import {
  effectiveExpenseSpendingCategoriesSql,
  effectiveExpenseSpendingCategorySql,
  resolveAggregateExpenseCategories,
} from "~/server/domains/expense/repo/expense-category-resolution";
import {
  accountPurchaserKey,
  liveHouseholdLoan,
  financialAccountPurchaser,
} from "~/server/domains/financial-account/policy/purchaser";
import { loadAccountPurchaserProofs } from "~/server/domains/financial-account/repo/purchaser";
import {
  digestValue,
  digestCanonicalEvidenceStream,
} from "~/server/domains/financial-transaction/policy/booking-fingerprint";
import {
  availableSpendingMinor,
  recordedSpendingOutcome,
} from "~/server/domains/financial-transaction/policy/recorded-spending";
import {
  decideSpendingCandidates,
  type SpendingCandidateRead,
} from "~/server/domains/financial-transaction/policy/spending-candidates";
import {
  spendingCategoryForDiscovery,
  refundSpendingCategory,
  bookingSpendingCategory,
  reviewedCategoryRefusal,
} from "~/server/domains/financial-transaction/policy/spending-category";
import {
  spendingBlocker,
  issuerCardFee,
} from "~/server/domains/financial-transaction/policy/spending-prerequisites";
import { allocationDollars } from "~/server/domains/financial-transaction/repo/allocation-money";
import {
  bookFreshFinancialTransactions,
  bookLockedFinancialTransactions,
  bookingGraph,
  type KnownBookingFacts,
  bookingGraphs,
  loadFinancialBookingLineage,
  loadFinancialBookingLineages,
  previewFinancialBooking,
} from "~/server/domains/financial-transaction/repo/financial-booking";
import {
  financialSourceRefsFor,
  financialSourceRefsIncluding,
  withFinancialSourceRef,
} from "~/server/domains/financial-transaction/repo/financial-source-evidence";
import { lockFinancialTransactionSources } from "~/server/domains/financial-transaction/repo/financial-source-evidence";
import { transactionDollars } from "~/server/domains/financial-transaction/repo/transaction-money";
import { retainedSettlementDiscoveryCouldMatch } from "~/server/domains/purchase-import/policy/retained-payments";
import { paymentEvidenceDollars } from "~/server/domains/purchase-import/repo/payment-evidence";
import {
  planPurchaseRetainedSettlement,
  prepareRetainedSettlementDiscovery,
  settlePurchaseFromRetainedPayments,
} from "~/server/domains/purchase-import/repo/retained-settlement";
import {
  bookingVendorCreations,
  bookingVendorSelection,
  createdVendorConflict,
} from "~/server/domains/vendor/policy/booking-vendor";
import type { WriteLayer } from "~/server/entity-kernel/repo/write-layer";
import { mintNamesInLayer, resolveNames } from "~/server/entity-kernel/resolve";
import { AppError, createAppError } from "~/server/errors/app-error";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { eligibleTargets } from "~/server/generic/suggestions/repo/eligible-targets";
import {
  canonicalJson,
  jsonSnapshot,
  writeCanonicalJson,
} from "~/server/lib/canonical-json";

function refuse(message: string): never {
  throw createAppError("CONSTRAINT_VIOLATION", message);
}

type Request = z.infer<typeof financialSpendingRequest>;
export async function financialSpendingAccountIdentity(
  db: Database,
  id: string,
) {
  return (
    await getDb(db)
      .select({ identity: financialAccount.identity })
      .from(financialAccount)
      .where(eq(financialAccount.id, parseEntityId("financialAccount", id)))
  )[0];
}
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
  explicit?: boolean;
  // Additional older spending can stop creation, never authorize settlement.
  reviewOnly?: boolean;
};
/**
 * Read-only metadata for one synchronous proposal page, or for one commit's
 * rechecks under its locks before it writes; never reuse across model work
 * or past a write.
 */
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
    ? await getDb(db)
        .query.financialTransaction.findMany({
          where: {
            RAW: (table: PgTable) =>
              relationalSql(
                table,
                and(
                  inArray(financialTransaction.id, [
                    ...new Set(input.transactionIds),
                  ]),
                  notDeleted(financialTransaction),
                ),
              ),
          },
        })
        .then((rows) => rows.map(transactionDollars))
    : [];
  const accountIds = [
    ...new Set([
      ...input.accountIds,
      ...transactions.map((row) => row.accountId),
    ]),
  ];
  const accounts = accountIds.length
    ? await getDb(db).query.financialAccount.findMany({
        where: {
          RAW: (table: PgTable) =>
            relationalSql(
              table,
              and(
                inArray(financialAccount.id, accountIds),
                notDeleted(financialAccount),
              ),
            ),
        },
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
  const references = await financialSourceRefsFor(db, transactionIds);
  const allocations = transactionIds.length
    ? await getDb(db)
        .query.financialTransactionAllocation.findMany({
          where: {
            RAW: (table: PgTable) =>
              relationalSql(
                table,
                and(
                  inArray(
                    financialTransactionAllocation.transactionId,
                    transactionIds,
                  ),
                  notDeleted(financialTransactionAllocation),
                ),
              ),
          },
          orderBy: (table: PgTable) =>
            [financialTransactionAllocation.purchaseId]
              .flat()
              .map((value) => relationalSql(table, value)),
        })
        .then((rows) => rows.map(allocationDollars))
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
  // Only a fingerprinted booking's existing-spending check reads its lineage.
  const fingerprinted = transactions.flatMap((row) =>
    row.bookingExpenseFingerprint
      ? [parseShortcodeFor("financialTransaction", row.shortcode)]
      : [],
  );
  const page = {
    sources,
    lineages: fingerprinted.length
      ? await loadFinancialBookingLineages(db, fingerprinted)
      : new Map<
          string,
          Awaited<ReturnType<typeof loadFinancialBookingLineage>>
        >(),
    retainedSettlement: await prepareRetainedSettlementDiscovery(getDb(db), []),
    candidateBounds,
    candidateAmounts: new Set(amounts),
    candidateReads: new Map<string, Promise<SpendingCandidateRead[]>>(),
    references,
    allocations: allocationsByTransaction,
    accounts: accountsById,
    purchaserProofs,
    transactions: transactionsById,
    // Promise caching coalesces concurrent identical reads without extending
    // their lifetime beyond this page.
    vendors: new Map<string, ReturnType<typeof resolveSpendingVendors>>(),
    pendingVendorNames: new Set<string>(),
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

/**
 * Hydrate the candidate union once; each preview still selects its exact
 * evidence. `vendorNames` are cleaned names the previews will also resolve.
 */
export async function prepareFinancialSpendingCandidates(
  db: Database,
  page: FinancialSpendingPage,
  vendorNames: readonly string[] = [],
) {
  const names = [
    ...new Set([
      ...page.sources.flatMap((source) => {
        const name = source.merchant?.trim() || source.rawDescription?.trim();
        return name ? [name] : [];
      }),
      ...vendorNames,
    ]),
  ];
  const resolved = await resolveSpendingVendors(db, names);
  const byName = new Map(resolved.map((result) => [result.name, result]));
  for (const result of resolved)
    page.vendors.set(canonicalJson([result.name]), Promise.resolve([result]));
  // Advice names a matched Vendor by its own name, which a preview resolves
  // beside the merchant; the first such preview resolves them all at once.
  for (const result of resolved)
    if (result.row && !byName.has(result.row.name))
      page.pendingVendorNames.add(result.row.name);
  const vendorIds = [
    ...new Set(
      resolved.flatMap((result) => (result.row ? [result.row.id] : [])),
    ),
  ];
  await prepareVendorCandidates(db, page, vendorIds);
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

/** Each Vendor's category history and candidate pool, read once for the page. */
async function prepareVendorCandidates(
  db: Database,
  page: FinancialSpendingPage,
  vendorIds: readonly string[],
) {
  for (const [vendorId, history] of await financialSpendingCategoryHistories(
    db,
    vendorIds.filter((vendorId) => !page.categoryHistory.has(vendorId)),
  ))
    page.categoryHistory.set(vendorId, Promise.resolve(history));
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
  const transactionCode = request.transactionId;
  const row = transactionCode
    ? page
      ? page.transactions.get(transactionCode)
      : await getDb(db)
          .query.financialTransaction.findFirst({
            where: {
              RAW: (table: PgTable) =>
                relationalSql(
                  table,
                  and(
                    eq(financialTransaction.shortcode, transactionCode),
                    notDeleted(financialTransaction),
                  ),
                ),
            },
          })
          .then((row) => (row ? transactionDollars(row) : row))
    : undefined;
  if (request.transactionId && !row)
    refuse("The spending transaction is no longer live.");
  const account = page
    ? page.accounts.get(row?.accountId ?? request.source?.accountId ?? "")
    : await getDb(db).query.financialAccount.findFirst({
        where: {
          RAW: (table: PgTable) =>
            relationalSql(
              table,
              row
                ? and(
                    eq(financialAccount.id, row.accountId),
                    notDeleted(financialAccount),
                  )
                : and(
                    eq(
                      financialAccount.shortcode,
                      request.source?.accountId ?? "",
                    ),
                    notDeleted(financialAccount),
                  ),
            ),
        },
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
          : ((await financialSourceRefsFor(db, [row.id])).get(row.id) ?? []),
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
      : await getDb(db)
          .query.financialTransactionAllocation.findMany({
            where: {
              RAW: (table: PgTable) =>
                relationalSql(
                  table,
                  and(
                    eq(financialTransactionAllocation.transactionId, row.id),
                    notDeleted(financialTransactionAllocation),
                  ),
                ),
            },
            orderBy: (table: PgTable) =>
              [financialTransactionAllocation.purchaseId]
                .flat()
                .map((value) => relationalSql(table, value)),
          })
          .then((rows) => rows.map(allocationDollars))
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

/** Reserve the whole batch before another preview can request overlapping graphs. */
async function prepareSpendingGraphs(
  db: Database,
  purchaseIds: Parameters<typeof loadSpendingGraphs>[1],
  page?: FinancialSpendingPage,
): ReturnType<typeof loadSpendingGraphs> {
  if (!page || !purchaseIds.length) return loadSpendingGraphs(db, purchaseIds);
  const loading = loadSpendingGraphs(db, purchaseIds);
  const entries = purchaseIds.map((id) => {
    const pending = loading.then(
      (graphs) => graphs.get(id) ?? loadSpendingGraph(db, id),
    );
    page.graphs.set(id, pending);
    return pending.then((graph) => [id, graph] as const);
  });
  return new Map(await Promise.all(entries));
}

async function loadSpendingGraphs(
  db: Database,
  purchaseIds: readonly NonNullable<Parameters<typeof bookingGraph>[1]>[],
) {
  const ids = [...new Set(purchaseIds)];
  const batchSize = 128;
  const graphs = await loadSpendingGraphBatch(db, ids.slice(0, batchSize));
  for (let offset = batchSize; offset < ids.length; offset += batchSize) {
    for (const [id, graph] of await loadSpendingGraphBatch(
      db,
      ids.slice(offset, offset + batchSize),
    ))
      graphs.set(id, graph);
  }
  return graphs;
}

async function loadSpendingGraphBatch(
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
    WHERE e."purchaseId" = ANY(${uuidArrayParam(ids)}) AND ${notDeleted("e")} ORDER BY e.id
  `)
      ).rows
    : [];
  // These raw fields enter retained snapshots: preserve pg float8 values and legacy accumulation.
  const settlements = ids.length
    ? (
        await getDb(db).execute<{
          purchaseId: string;
          transactionId: string;
          accountId: string;
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
        }>(sql`SELECT a."purchaseId", a."transactionId", f."accountId", f.shortcode AS "transactionCode", (${minorToDollarsSql(sql`a."amountMinor"`, "float8")}) AS amount, f.kind, f.status, f."deletedAt", f."ledgerTransferId",
    (${minorToDollarsSql(sql`f."amountMinor"`, "float8")}) AS "transactionAmount", fa."deletedAt" AS "accountDeletedAt",
    (SELECT sum(${minorToDollarsSql(sql`coverage."amountMinor"`, "float8")}) FROM "FinancialTransactionAllocation" coverage
      WHERE coverage."transactionId" = f.id AND ${notDeleted("coverage")}) AS "allocatedAmount",
    (to_jsonb(f)-'amountMinor')||jsonb_build_object('amount',${minorToDollarsSql(sql`f."amountMinor"`, "float8")}) AS transaction, to_jsonb(fa) AS account, to_jsonb(lp) AS owner
    FROM "FinancialTransactionAllocation" a JOIN "FinancialTransaction" f ON f.id = a."transactionId"
    JOIN "FinancialAccount" fa ON fa.id = f."accountId"
    LEFT JOIN "LedgerParty" lp ON lp.id = fa."ledgerPartyId"
    WHERE a."purchaseId" = ANY(${uuidArrayParam(ids)}) AND ${notDeleted("a")} ORDER BY a."transactionId", a.id
  `)
      ).rows
    : [];
  const categoriesByPurchase = groupBy(categories, (row) => row.purchaseId);
  const settlementsByPurchase = groupBy(settlements, (row) => row.purchaseId);
  return new Map(
    [...graphs].map(([id, graph]) => {
      const complete = {
        ...graph,
        categories: (categoriesByPurchase[id] ?? []).map(
          ({ purchaseId: _purchaseId, ...row }) => row,
        ),
        settlements: (settlementsByPurchase[id] ?? []).map(
          ({ purchaseId: _purchaseId, ...row }) => row,
        ),
      };
      return [
        id,
        {
          // Keep every original snapshot dependency without retaining its row graph.
          canonical: canonicalJson(jsonSnapshot.parse(complete)),
          target: graph.target
            ? {
                id: graph.target.id,
                shortcode: graph.target.shortcode,
                vendorId: graph.target.vendorId,
                statedTotal: graph.target.statedTotal,
              }
            : undefined,
          lines: graph.lines.map((line) => ({
            id: line.id,
            cost: line.cost,
            future: line.future,
            economicRole: line.economicRole,
            lineKind: line.lineKind,
            bookingTransactionCode: line.bookingTransactionCode,
          })),
          categories: complete.categories,
          settlements: complete.settlements.map(
            ({
              transaction: _transaction,
              account: _account,
              owner: _owner,
              ...settlement
            }) => settlement,
          ),
        },
      ] as const;
    }),
  );
}

/** Reinsert normalized graph JSON without cloning every candidate graph again. */
function digestSpendingEvidence(
  evidence: unknown,
  graphEvidence: { graphs: readonly string[]; candidates?: readonly string[] },
) {
  const normalized = jsonSnapshot.parse(evidence);
  if (
    !normalized ||
    typeof normalized !== "object" ||
    Array.isArray(normalized)
  )
    throw new Error("Spending snapshot must be an object.");
  return digestCanonicalEvidenceStream((write) => {
    const writeGraph = (graph: string) => {
      for (let start = 0; start < graph.length;) {
        let end = Math.min(start + 32_768, graph.length);
        const last = graph.charCodeAt(end - 1);
        const next = graph.charCodeAt(end);
        if (
          last >= 0xd800 &&
          last <= 0xdbff &&
          next >= 0xdc00 &&
          next <= 0xdfff
        )
          end--;
        write(graph.slice(start, end));
        start = end;
      }
    };
    const writeObject = (
      value: Record<string, z.infer<ReturnType<typeof z.json>>>,
      replace: (key: string) => boolean,
    ) => {
      write("{");
      for (const [index, key] of Object.keys(value).sort().entries()) {
        if (index) write(",");
        write(JSON.stringify(key));
        write(":");
        if (!replace(key)) writeCanonicalJson(value[key]!, write);
      }
      write("}");
    };
    writeObject(normalized, (key) => {
      const graphs =
        key === "graphs"
          ? graphEvidence.graphs
          : key === "candidates"
            ? graphEvidence.candidates
            : undefined;
      if (!graphs) return false;
      const entries = normalized[key];
      if (!Array.isArray(entries) || entries.length !== graphs.length)
        throw new Error("Spending snapshot graph positions changed.");
      write("[");
      for (const [index, entry] of entries.entries()) {
        if (index) write(",");
        if (key === "graphs") writeGraph(graphs[index]!);
        else {
          if (
            !entry ||
            typeof entry !== "object" ||
            Array.isArray(entry) ||
            !Object.hasOwn(entry, "graph")
          )
            throw new Error(
              "Spending candidate snapshot must retain its graph.",
            );
          writeObject(entry, (field) => {
            if (field !== "graph") return false;
            writeGraph(graphs[index]!);
            return true;
          });
        }
      }
      write("]");
      return true;
    });
  });
}

/**
 * Purchases whose every settling Transaction an occurrence accepted that is
 * provably a different bank event from this charge's: another provider ID in
 * the same provider scope, or another position in the same collection. A
 * legacy, reviewed or cross-kind pair may be one event and proves nothing.
 */
async function settledByOtherOccurrences(
  db: Database,
  purchases: readonly { id: string; transactionIds: readonly string[] }[],
  sourceRefs: readonly { source: string; externalId: string }[],
) {
  const settled = purchases.filter(
    (purchase) => purchase.transactionIds.length,
  );
  const ids = [
    ...new Set(settled.flatMap((purchase) => purchase.transactionIds)),
  ];
  if (!ids.length || !sourceRefs.length) return new Set<string>();
  const provider = sqlEnumConstant(
    sourceOccurrenceIdentityKind,
    sourceOccurrenceIdentityKind.enum.provider,
  );
  const positioned = sqlEnumConstant(
    sourceOccurrenceIdentityKind,
    sourceOccurrenceIdentityKind.enum.positioned,
  );
  const refs = requestedRows(
    sourceRefs.map((ref) => ({
      source: ref.source,
      shortcode: ref.externalId,
    })),
    { source: "text", shortcode: "text" },
    "ref",
  );
  const proven = await getDb(db).execute<{ id: string }>(sql`
    SELECT DISTINCT o."acceptedTransactionId"::text AS id
    FROM "SourceOccurrence" o
    JOIN "SourceOccurrence" incoming ON incoming.source = o.source
      AND incoming.id <> o.id AND ${notDeleted("incoming")}
      AND (incoming.source, incoming.shortcode) IN (
        SELECT ${refs.col("source")}, ${refs.col("shortcode")} FROM ${refs.from})
    WHERE ${notDeleted("o")} AND o."supersededByOccurrenceId" IS NULL
      AND o.disposition <> ${sqlEnumConstant(sourceTransactionRecordDisposition, sourceTransactionRecordDisposition.enum.ignored)}
      AND o."acceptedTransactionId" = ANY(${uuidArrayParam(ids)})
      AND ((o."identityKind" = ${provider} AND incoming."identityKind" = ${provider}
          AND o."identityScope" = incoming."identityScope"
          AND o."providerIdentity" <> incoming."providerIdentity")
        OR (o."identityKind" = ${positioned} AND incoming."identityKind" = ${positioned}
          AND o."physicalImportId" = incoming."physicalImportId"
          AND o."physicalPosition" <> incoming."physicalPosition"))`);
  const accepted = new Set(proven.rows.map((entry) => String(entry.id)));
  return new Set(
    settled
      .filter((purchase) =>
        purchase.transactionIds.every((id) => accepted.has(String(id))),
      )
      .map((purchase) => purchase.id),
  );
}

/** Same-direction settlements of other charges, excluding reimbursement and income legs. */
function otherSettlements(
  graph: Awaited<ReturnType<typeof spendingGraph>>,
  amount: number,
  currentId?: string,
) {
  const reimbursements = new Set(
    graph.lines
      .filter((line) => line.economicRole === "reimbursement")
      .map((line) => line.bookingTransactionCode),
  );
  return graph.settlements.filter(
    (entry) =>
      entry.transactionId !== currentId &&
      entry.kind !== "income" &&
      !reimbursements.has(entry.transactionCode) &&
      Math.sign(Number(entry.amount)) === Math.sign(amount),
  );
}

function availableCents(
  graph: Awaited<ReturnType<typeof spendingGraph>> | undefined,
  amount: number,
  currentId?: string,
) {
  const capacity = availableSpendingMinor(
    graph && {
      lines: graph.lines.map((line) => ({
        ...line,
        costMinor: line.cost === null ? null : moneyToMinor(line.cost),
      })),
      settlements: graph.settlements.map((row) => ({
        ...row,
        amountMinor: moneyToMinor(Number(row.amount)),
        transactionAmountMinor: moneyToMinor(Number(row.transactionAmount)),
        allocatedMinor: moneyToMinor(Number(row.allocatedAmount)),
        deleted: Boolean(row.deletedAt),
        accountDeleted: Boolean(row.accountDeletedAt),
      })),
    },
    moneyToMinor(amount),
    currentId,
  );
  return capacity === null ? null : Number(capacity);
}

/** `financialSpendingCategoryHistory` for several Vendors in one statement. */
async function financialSpendingCategoryHistories(
  db: Database,
  vendorIds: readonly string[],
) {
  const rows = vendorIds.length
    ? (
        await getDb(db).execute<{
          vendorId: string;
          category: string | null;
          name: string | null;
          lines: number;
        }>(sql`
    WITH selected_expenses AS (
      SELECT e.id, e."purchaseId", e."productId", e."spendingCategoryId", e."lineKind", p."vendorId"
      FROM "Expense" e JOIN "Purchase" p ON p.id=e."purchaseId"
      WHERE p."vendorId" = ANY(${uuidArrayParam(vendorIds)}) AND ${notDeleted("p")} AND ${notDeleted("e")} AND NOT e.future
    ), resolved AS (
      ${effectiveExpenseSpendingCategoriesSql(sql`selected_expenses`)}
    )
    SELECT s."vendorId", r."spendingCategoryId" AS category, c.name, count(*)::int AS lines
    FROM resolved r
    JOIN selected_expenses s ON s.id=r."expenseId"
    LEFT JOIN "SpendingCategory" c ON c.id=r."spendingCategoryId" AND ${notDeleted("c")}
    GROUP BY s."vendorId", r."spendingCategoryId", c.name ORDER BY s."vendorId", category NULLS FIRST
  `)
      ).rows
    : [];
  const byVendor = groupBy(rows, (row) => String(row.vendorId));
  return new Map(
    vendorIds.map((vendorId) => [
      vendorId,
      (byVendor[vendorId] ?? []).map(({ category, name, lines }) => ({
        category,
        name,
        lines,
      })),
    ]),
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
  if (
    !request.advice &&
    !request.reviewedVendorName &&
    !request.spendingCategoryId
  )
    return null;
  return financialSpendingAdvice.parse({
    ...request.advice,
    spendingCategoryId: null,
    categoryConfidence: "low",
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
  page?: Pick<FinancialSpendingPage, "vendors"> &
    Partial<Pick<FinancialSpendingPage, "pendingVendorNames">>,
) {
  const key = canonicalJson([...names]);
  const cached = page?.vendors.get(key);
  if (cached) return cached;
  const pending = page?.pendingVendorNames;
  if (pending && names.some((name) => pending.has(name))) {
    const deferred = [...pending];
    pending.clear();
    const lookup = resolveSpendingVendors(db, deferred);
    for (const [index, name] of deferred.entries())
      page.vendors.set(
        canonicalJson([name]),
        lookup.then((results) => [results[index]!]),
      );
  }
  // Each name resolves independently, so cached single names compose. A
  // case-only repeat matches the same rows; callers read rows and candidates,
  // never the echoed name.
  const parts = names.map((name) => page?.vendors.get(canonicalJson([name])));
  if (names.length > 1 && parts.every(Boolean))
    return Promise.all(parts).then((results) => results.flatMap((r) => r!));
  const lookup = names.length
    ? resolveSpendingVendors(db, names)
    : Promise.resolve([]);
  page?.vendors.set(key, lookup);
  return lookup;
}

async function purchasePayments(db: Database, purchaseIds: readonly string[]) {
  if (!purchaseIds.length) return [];
  return (
    await getDb(db)
      .select()
      .from(purchasePaymentEvidence)
      .where(
        inArray(
          purchasePaymentEvidence.purchaseId,
          purchaseIds.map((id) => parseEntityId("purchase", id)),
        ),
      )
      .orderBy(purchasePaymentEvidence.id)
  ).map(paymentEvidenceDollars);
}

async function prepareSpendingPayments(
  db: Database,
  purchaseIds: readonly string[],
  page?: FinancialSpendingPage,
) {
  const ids = [...new Set(purchaseIds)];
  const missing = ids.filter((id) => !page?.payments.has(id));
  const loading: Promise<
    Record<string, Awaited<ReturnType<typeof purchasePayments>>>
  > = missing.length
    ? purchasePayments(db, missing).then((rows) =>
        groupBy(rows, (row) => row.purchaseId),
      )
    : Promise.resolve({});
  const entries = ids.map((id) => {
    const pending =
      page?.payments.get(id) ?? loading.then((rows) => rows[id] ?? []);
    // Reserve every missing read before another preview can request the batch.
    page?.payments.set(id, pending);
    return pending.then((rows) => [id, rows] as const);
  });
  return new Map(await Promise.all(entries));
}

const calendarGap = (left: string, right: string) =>
  Math.abs(Date.parse(left) - Date.parse(right)) / 86_400_000;
const REFUND_WINDOW_DAYS = 14;

type CandidateInput = {
  date: string;
  amount: number;
  refund: boolean;
  vendorId?: string;
  purchaseId?: string | null;
};

/** Purchases with an undated retained payment of one of these amounts. */
const undatedPaymentIds = (amounts: readonly number[]) => sql`
  SELECT undated."purchaseId" FROM "PurchasePaymentEvidence" undated
  WHERE undated."chargedAt"::date IS NULL
    AND undated."amountMinor" = ANY(${columnArrayParam(amounts)})`;

/**
 * A superset of the Vendors' candidate Purchases, each arm served by an index:
 * the nearby date window, Purchases with a positive allocation (partly paid
 * spending needs one), and undated retained payments of a page amount. The
 * caller still applies the full candidate predicate, so a serializable read
 * locks these index ranges instead of every Purchase graph of the Vendor.
 */
const vendorCandidateIds = (
  vendorIds: readonly string[],
  bounds: { first: string; last: string },
  amounts: readonly number[],
) => sql`
  SELECT nearby.id FROM "Purchase" nearby
  WHERE nearby."vendorId" = ANY(${uuidArrayParam(vendorIds)})
    AND nearby.date BETWEEN ${bounds.first}::date-14 AND ${bounds.last}::date+14
  UNION
  SELECT paid."purchaseId" FROM "FinancialTransactionAllocation" paid
  JOIN "Purchase" owner ON owner.id = paid."purchaseId"
  WHERE owner."vendorId" = ANY(${uuidArrayParam(vendorIds)})
    AND ${notDeleted("paid")} AND paid."amountMinor" > 0
  ${amounts.length ? sql`UNION ${undatedPaymentIds(amounts)}` : sql``}`;

type CandidateRawRead = Omit<
  SpendingCandidateRead,
  "expenses" | "payments" | "settlements"
> & {
  expenses: { costMinor: string | null; lineKind: string }[];
  payments: { amountMinor: string; chargedDate: string | null }[];
  settlements: (Omit<
    SpendingCandidateRead["settlements"][number],
    "amountMinor" | "transactionAmountMinor" | "allocatedMinor"
  > & {
    amountMinor: string;
    transactionAmountMinor: string;
    allocatedMinor: string;
  })[];
};

/** Load the indexed superset, including empty evidence sets, before any candidate decision. */
async function spendingCandidateReads(
  db: Database,
  input: CandidateInput,
  bounds: { first: string; last: string },
  amounts: readonly number[],
): Promise<SpendingCandidateRead[]> {
  const rows = await getDb(db).execute<CandidateRawRead>(sql`
    SELECT p.id,p.shortcode,p."displayLabel",p.date,p."vendorId",
      ARRAY(SELECT jsonb_build_object('costMinor',e."costMinor"::text,${"lineKind"}::text,e."lineKind") FROM "Expense" e
        WHERE e."purchaseId"=p.id AND ${notDeleted("e")} AND NOT e.future AND e."economicRole"=${financialBookingInput.shape.economicRole.unwrap().enum.vendor}) AS expenses,
      ARRAY(SELECT jsonb_build_object('amountMinor',payment."amountMinor"::text,'chargedDate',payment."chargedAt"::date::text)
        FROM "PurchasePaymentEvidence" payment WHERE payment."purchaseId"=p.id) AS payments,
      ARRAY(SELECT jsonb_build_object('amountMinor',paid."amountMinor"::text,'transactionAmountMinor',pf."amountMinor"::text,
        'allocatedMinor',(SELECT sum(coverage."amountMinor")::text FROM "FinancialTransactionAllocation" coverage WHERE coverage."transactionId"=pf.id AND ${notDeleted("coverage")}),
        'transactionDeleted',pf."deletedAt" IS NOT NULL,'accountDeleted',pa."deletedAt" IS NOT NULL,'status',pf.status,
        'ledgerTransferId',pf."ledgerTransferId",${"kind"}::text,pf.kind,${financialBookingInput.shape.economicRole.unwrap().enum.reimbursement}::text,EXISTS(SELECT 1 FROM "Expense" e WHERE e."purchaseId"=p.id AND ${notDeleted("e")} AND e."bookingTransactionCode"=pf.shortcode AND e."economicRole"=${financialBookingInput.shape.economicRole.unwrap().enum.reimbursement}))
        FROM "FinancialTransactionAllocation" paid JOIN "FinancialTransaction" pf ON pf.id=paid."transactionId" JOIN "FinancialAccount" pa ON pa.id=pf."accountId"
        WHERE paid."purchaseId"=p.id AND ${notDeleted("paid")}) AS settlements
    FROM "Purchase" p WHERE ${notDeleted("p")} AND p.id IN (
      SELECT named.id FROM "Purchase" named WHERE named.shortcode=${input.purchaseId ?? null}
      UNION SELECT payment."purchaseId" FROM "PurchasePaymentEvidence" payment WHERE payment."amountMinor"=ANY(${columnArrayParam(amounts)}) AND payment."chargedAt"::date BETWEEN ${bounds.first}::date-3 AND ${bounds.last}::date+3
      UNION ${input.vendorId ? vendorCandidateIds([input.vendorId], bounds, amounts) : undatedPaymentIds(amounts)}
    ) ORDER BY p.id`);
  return rows.rows.map((row) => ({
    ...row,
    expenses: row.expenses.map((line) => ({
      ...line,
      costMinor: line.costMinor === null ? null : BigInt(line.costMinor),
    })),
    payments: row.payments.map((payment) => ({
      ...payment,
      amountMinor: BigInt(payment.amountMinor),
    })),
    settlements: row.settlements.map((payment) => ({
      ...payment,
      amountMinor: BigInt(payment.amountMinor),
      transactionAmountMinor: BigInt(payment.transactionAmountMinor),
      allocatedMinor: BigInt(payment.allocatedMinor),
    })),
  }));
}

async function spendingCandidates(
  db: Database,
  input: CandidateInput,
  page?: FinancialSpendingPage,
): Promise<SpendingCandidate[]> {
  const bounds = page?.candidateBounds;
  const pooled =
    page &&
    bounds &&
    page.candidateAmounts.has(input.amount) &&
    input.date >= bounds.first &&
    input.date <= bounds.last;
  const scope = pooled ? bounds : { first: input.date, last: input.date };
  const amounts = pooled ? [...page.candidateAmounts] : [input.amount];
  const key = canonicalJson([
    input.vendorId ?? null,
    input.purchaseId ?? null,
    scope,
    amounts,
  ]);
  let rows = pooled ? page.candidateReads.get(key) : undefined;
  if (!rows) {
    rows = spendingCandidateReads(db, input, scope, amounts);
    if (pooled) page.candidateReads.set(key, rows);
  }
  return decideSpendingCandidates(
    { ...input, amountMinor: BigInt(input.amount) },
    await rows,
  );
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

function loadSpendingCategory(
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
  // Coalesce concurrent page reads, including misses.
  const lookup = getDb(db)
    .query.spendingCategory.findMany({
      where: {
        RAW: (table: PgTable) =>
          relationalSql(
            table,
            and(
              "id" in reference
                ? eq(spendingCategory.id, reference.id)
                : eq(spendingCategory.shortcode, reference.shortcode),
              notDeleted(spendingCategory),
            ),
          ),
      },
    })
    .then((rows) => spendingCategoryForDiscovery(rows, reference));
  page?.categories.set(key, lookup);
  return lookup;
}

/** Discovery does not authorize a write; the same retained evidence is rebuilt at commit. */
// eslint-disable-next-line complexity -- Discovery combines booking evidence and candidate eligibility.
async function discoverSpendingEvidence(
  db: Database,
  request: Request,
  facts: Awaited<ReturnType<typeof spendingFacts>>,
  page?: FinancialSpendingPage,
) {
  const { row, source, account, allocations, graphs } = facts;
  let advice = reviewedSpendingAdvice(request);
  const issuerFee = issuerCardFee(facts);
  const issuer =
    issuerFee && account.providerVendorId
      ? await getDb(db).query.vendor.findFirst({
          where: {
            RAW: (table: PgTable) =>
              relationalSql(
                table,
                and(
                  eq(vendorTable.id, account.providerVendorId!),
                  notDeleted(vendorTable),
                ),
              ),
          },
        })
      : undefined;
  const names = [
    ...new Set(
      [
        issuerFee
          ? issuer?.name
          : source.merchant?.trim() || source.rawDescription?.trim(),
        issuerFee ? undefined : advice?.vendorName,
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
  const selectedVendorCode = request.vendorId;
  const selectedVendor = selectedVendorCode
    ? await getDb(db).query.vendor.findFirst({
        where: {
          RAW: (table: PgTable) =>
            relationalSql(
              table,
              and(
                eq(vendorTable.shortcode, selectedVendorCode),
                notDeleted(vendorTable),
              ),
            ),
        },
      })
    : undefined;
  const vendor =
    selectedVendor ??
    (issuerFee
      ? issuer
      : vendors.size === 1
        ? [...vendors.values()][0]
        : undefined);
  let category = advice?.spendingCategoryId
    ? await loadSpendingCategory(
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
  const classifications =
    (
      await eligibleTargets(db, [
        {
          key: "spending",
          kind: "purchase",
          ids: candidates.map((candidate) => candidate.id),
          explicitIds: candidates
            .filter((candidate) => candidate.explicit)
            .map((candidate) => candidate.id),
          amountMinor: cents(source.amount),
          currentTransactionId: row?.id,
        },
      ])
    ).get("spending") ?? [];
  const eligibility = new Map(
    classifications.map((target) => [target.id, target.eligibility]),
  );
  const contextReasons = new Map(
    classifications.map((target) => [
      target.id,
      target.eligibility === "context" ? target.reason : null,
    ]),
  );
  // Older review-only spending never settles; the rest follows shared eligibility.
  const settles = (candidate: SpendingCandidate) =>
    !candidate.reviewOnly && eligibility.get(candidate.id) !== "context";
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
          .filter(settles)
          .map((candidate) => parseEntityId("purchase", candidate.id)),
      ));
    for (const candidate of unrejectedCandidates) {
      if (!settles(candidate)) continue;
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
  const loadedGraphs = await prepareSpendingGraphs(db, uncachedIds, page);
  const payments = await prepareSpendingPayments(
    db,
    graphCandidates.filter(settles).map((candidate) => candidate.id),
    page,
  );
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
      payments: settles(candidate)
        ? (payments.get(candidate.id) ??
          (await purchasePayments(db, [candidate.id])))
        : [],
      plan: strong.get(candidate.shortcode) ?? null,
    })),
  );
  const candidateGraphs = new Map(
    candidateEvidence.map((candidate) => [candidate.id, candidate.graph]),
  );
  // Exhausted capacity alone never proves a different event: a nearby
  // Purchase stops blocking only when every settlement is provably another
  // bank event of this charge's source, as an earlier booking from the same
  // provider feed creates. Manual or unproven settlements may be this charge.
  const exhausted = unrejectedCandidates.filter((candidate) => {
    if (
      candidate.reviewOnly ||
      strong.has(candidate.shortcode) ||
      candidate.shortcode === request.purchaseId ||
      source.kind === "refund"
    )
      return false;
    const evidence = candidateEvidence.find(
      (entry) => entry.id === candidate.id,
    );
    return (
      !evidence?.payments.some(
        (payment) =>
          Math.abs(cents(payment.amount)) === Math.abs(cents(source.amount)),
      ) &&
      availableCents(
        candidateGraphs.get(candidate.id),
        source.amount,
        row?.id,
      ) === 0
    );
  });
  // A settling charge of another amount is another bank event. Pending and
  // observed (unknown status) amounts may still be revised, so only posted
  // amounts on both sides prove it.
  const otherAmounts = new Set(
    exhausted
      .filter((candidate) => {
        const graph = candidateGraphs.get(candidate.id);
        const settled = graph
          ? otherSettlements(graph, source.amount, row?.id)
          : [];
        return (
          source.status === "posted" &&
          settled.length > 0 &&
          settled.every(
            (entry) =>
              entry.status === "posted" &&
              Math.abs(cents(Number(entry.transactionAmount))) !==
                Math.abs(cents(source.amount)),
          )
        );
      })
      .map((candidate) => candidate.id),
  );
  const distinctlySettled = await settledByOtherOccurrences(
    db,
    exhausted
      .filter((candidate) => !otherAmounts.has(candidate.id))
      .map((candidate) => ({
        id: candidate.id,
        transactionIds: (candidateGraphs.get(candidate.id)?.settlements ?? [])
          .map((entry) => entry.transactionId)
          .filter((id) => id !== row?.id),
      })),
    source.sourceRefs,
  );
  // A live Purchase another charge already settles may be this same charge; it
  // also stops a retained-payment target from winning over weak candidates.
  const settledLive = new Set<string>();
  const liveCandidates = unrejectedCandidates.filter((candidate) => {
    if (!candidate.reviewOnly) {
      // Spent capacity does not prove a different bank event: a settled or
      // short Purchase blocks unless its settling charges provably differ.
      const reason = contextReasons.get(candidate.id);
      if (reason === "settled" || reason === "amount") {
        if (
          distinctlySettled.has(candidate.id) ||
          otherAmounts.has(candidate.id)
        )
          return false;
        const graph = candidateGraphs.get(candidate.id);
        if (!graph || otherSettlements(graph, source.amount, row?.id).length)
          settledLive.add(candidate.id);
        return true;
      }
      return !reason;
    }
    const graph = candidateGraphs.get(candidate.id);
    // Only known capacity removes an added-only blocker: exhausted, or paid
    // beyond its lines. Unknown capacity cannot establish settlement.
    const available = availableCents(graph, source.amount, row?.id);
    return available === null || available > 0;
  });
  const live = new Set(liveCandidates);
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
      const categoryId = refundSpendingCategory(
        original.graph.lines.map((line) => ({
          ...line,
          costMinor: line.cost === null ? null : moneyToMinor(line.cost),
        })),
        original.graph.categories,
      );
      if (categoryId) {
        const inherited = await loadSpendingCategory(
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
      ...(request.costType === undefined ? {} : { costType: request.costType }),
      beneficiaries: request.beneficiaries,
      purchaseId: request.purchaseId,
      rejectedPurchaseIds: [...request.rejectedPurchaseIds].sort(),
    },
    candidates: candidateEvidence.map((candidate) => ({
      ...candidate,
      graph: null,
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
    graphs: graphs.map(() => null),
    transactionState: {
      ledgerTransferId: row?.ledgerTransferId ?? null,
      bookingDecisionFingerprint: row?.bookingDecisionFingerprint ?? null,
      bookingExpenseFingerprint: row?.bookingExpenseFingerprint ?? null,
      spendingCategoryId: row?.spendingCategoryId ?? null,
    },
  };
  const snapshot = await digestSpendingEvidence(snapshotEvidence, {
    graphs: graphs.map((graph) => graph.canonical),
    candidates: candidateEvidence.map((candidate) => candidate.graph.canonical),
  });
  const basis = {
    request,
    snapshot,
    candidates: unrejectedCandidates.map((candidate) => ({
      purchaseId: parseShortcodeFor("purchase", candidate.shortcode),
      name: candidate.displayLabel ?? candidate.shortcode,
      strength: !live.has(candidate)
        ? ("context" as const)
        : strong.has(candidate.shortcode)
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
    settledLive,
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
  page?: FinancialSpendingPage,
): Promise<FinancialSpendingPlan | null> {
  const { row, source, allocations, graphs } = facts;
  const lineageMatches =
    !allocations.length ||
    basis.request.beneficiaries !== undefined ||
    !row?.bookingExpenseFingerprint ||
    row.bookingExpenseFingerprint ===
      (await digestValue(
        page?.lineages.get(row.shortcode) ??
          (await loadFinancialBookingLineage(
            db,
            parseShortcodeFor("financialTransaction", row.shortcode),
          )),
      ));
  const outcome = recordedSpendingOutcome({
    amountMinor: moneyToMinor(source.amount),
    beneficiariesSpecified: basis.request.beneficiaries !== undefined,
    lineageMatches,
    allocations: allocations.map((allocation) => ({
      ...allocation,
      amountMinor: moneyToMinor(allocation.amount),
    })),
    purchases: graphs.map((graph) => ({
      id: graph.target?.id ?? "",
      shortcode: graph.target?.shortcode ?? "",
      availableMinor: (() => {
        const value = availableCents(graph, source.amount, row?.id);
        return value === null ? null : BigInt(value);
      })(),
    })),
  });
  if (!outcome) return null;
  return outcome.kind === "review"
    ? { ...basis, status: "review_required", reason: outcome.reason }
    : {
        ...basis,
        status: "already_booked",
        purchaseIds: outcome.purchaseIds
          .filter(Boolean)
          .map((id) => parseShortcodeFor("purchase", id)),
      };
}

// A receipt without payment evidence is this charge's Purchase only when the
// match is unique on both sides: one same-Vendor unpaid receipt within three
// days whose open capacity is exactly the charge, and no other unbooked charge
// for that amount near the receipt. Older partly paid spending still blocks.
// A refund's original is likewise one same-Vendor order from the preceding
// refund window whose open returned-line capacity is exactly the refund.
// Retained payment evidence belongs to the retained matcher, which may have
// rejected this charge (another card, for example); it never falls back here.
async function exactReceiptTarget(
  db: Database,
  evidence: Awaited<ReturnType<typeof discoverSpendingEvidence>>,
) {
  const { facts, liveCandidates, candidateEvidence, vendor } = evidence;
  const { row, source } = facts;
  const date = source.transactionDate ?? source.postedDate;
  const refund = source.kind === "refund" && source.amount < 0;
  if (
    !vendor ||
    !date ||
    !(refund || (source.kind === "purchase" && source.amount > 0)) ||
    liveCandidates.some((candidate) => candidate.reviewOnly)
  )
    return undefined;
  const amount = cents(source.amount);
  // Eligibility nets an order's returned lines into its total, so a refund
  // reads every selected original rather than only live candidates.
  const matches = (refund ? candidateEvidence : liveCandidates).filter(
    (candidate) => {
      const graph = candidateEvidence.find(
        (entry) => entry.id === candidate.id,
      )?.graph;
      return (
        candidate.date !== null &&
        (refund
          ? candidate.date <= date &&
            calendarGap(candidate.date, date) <= REFUND_WINDOW_DAYS
          : calendarGap(candidate.date, date) <= 3 &&
            graph?.settlements.length === 0) &&
        graph?.target?.vendorId === vendor.id &&
        availableCents(graph, source.amount, row?.id) === amount
      );
    },
  );
  if (matches.length !== 1) return undefined;
  const [match] = matches;
  // Competing evidence for the same amount: near the receipt, or between the
  // original order and the refund.
  const from = refund ? sql`${match!.date}::date` : sql`${match!.date}::date-3`;
  const to = refund ? sql`${date}::date+3` : sql`${match!.date}::date+3`;
  const charges = source.sourceRefs.map((ref) => ref.externalId);
  const competing = await getDb(db).execute<{ competing: number }>(sql`
    SELECT 1 AS competing FROM "FinancialTransaction" f
    WHERE ${notDeleted("f")} AND f.id IS DISTINCT FROM ${row?.id ?? null}::uuid
      AND f."amountMinor" = ${amount}
      AND f.status <> ${financialTransactionStatus.enum.void}
      AND coalesce(f."transactionDate", f."postedDate") BETWEEN ${from} AND ${to}
      AND NOT EXISTS (SELECT 1 FROM "FinancialTransactionAllocation" a
        WHERE a."transactionId" = f.id AND ${notDeleted("a")})
    UNION ALL
    SELECT 1 FROM "SourceOccurrence" o
    JOIN "SourceTransactionRecord" r ON r.id = o."currentObservationId"
    WHERE ${notDeleted("o")} AND o."withdrawnAt" IS NULL
      AND o."acceptedTransactionId" IS NULL
      AND o.source = ANY(${textArrayParam([...new Set(source.sourceRefs.map((ref) => ref.source))])})
      AND o.shortcode <> ALL(${textArrayParam([...charges])})
      AND r."amountMinor" = ${amount}
      AND r."statementDate" BETWEEN ${from} AND ${to}
    UNION ALL
    SELECT 1 FROM "PurchasePaymentEvidence" retained
    WHERE retained."purchaseId" = ${match!.id}::uuid
      AND (${!refund} OR retained."amountMinor" < 0)
    LIMIT 1
  `);
  return competing.rows.length ? undefined : match;
}

type PreparedFinancialSpendingPreview =
  | FinancialSpendingPlan
  | {
      draft:
        | Parameters<typeof resolveAggregateExpenseCategories>[1][number]
        | undefined;
      finish: (
        category:
          | Awaited<
              ReturnType<typeof resolveAggregateExpenseCategories>
            >[number]
          | undefined,
      ) => Promise<FinancialSpendingPlan>;
    };

export async function previewFinancialSpending(
  db: Database,
  raw: z.input<typeof financialSpendingRequest>,
  attachment?: {
    settlementRef: FinancialTransactionSourceRef;
    fields?: Partial<
      Pick<
        z.infer<typeof financialSpendingSource>,
        "amount" | "status" | "postedDate"
      >
    >;
  },
  page?: FinancialSpendingPage,
): Promise<FinancialSpendingPlan> {
  const [plan] = await previewFinancialSpendings(
    db,
    [{ request: raw, attachment }],
    page,
  );
  return plan!;
}

/** Resolve one category vector after every read-only preview has prepared its draft. */
export async function previewFinancialSpendings(
  db: Database,
  entries: readonly {
    request: z.input<typeof financialSpendingRequest>;
    attachment?: Parameters<typeof previewFinancialSpending>[2];
  }[],
  page: FinancialSpendingPage | undefined,
): Promise<FinancialSpendingPlan[]> {
  const prepared = [];
  for (const entry of entries)
    prepared.push(
      await prepareFinancialSpendingPreview(
        db,
        entry.request,
        entry.attachment,
        page,
      ),
    );
  const categories = await resolveAggregateExpenseCategories(
    db,
    prepared.flatMap((value) =>
      "finish" in value && value.draft ? [value.draft] : [],
    ),
  );
  let ordinal = 0;
  const plans = [];
  for (const value of prepared)
    plans.push(
      "finish" in value
        ? await value.finish(value.draft ? categories[ordinal++] : undefined)
        : value,
    );
  return plans;
}

async function prepareFinancialSpendingPreview(
  db: Database,
  raw: z.input<typeof financialSpendingRequest>,
  attachment?: {
    settlementRef: FinancialTransactionSourceRef;
    fields?: Partial<
      Pick<
        z.infer<typeof financialSpendingSource>,
        "amount" | "status" | "postedDate"
      >
    >;
  },
  page?: FinancialSpendingPage,
): Promise<PreparedFinancialSpendingPreview> {
  const request = spendingRequestBoundary.parse(raw);
  const facts = await spendingFacts(db, request, page, attachment?.fields);
  // Preview an impending reference attachment without duplicating its charge.
  // Commit still requires that reference to exist in retained evidence.
  if (attachment && facts.row) {
    // A page's references are the row's retained references read in this snapshot.
    facts.source.sourceRefs = page
      ? withFinancialSourceRef(
          page.references.get(facts.row.id) ?? [],
          attachment.settlementRef,
        )
      : await financialSourceRefsIncluding(
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
      snapshot: await digestSpendingEvidence(
        { ...facts, graphs: facts.graphs.map(() => null) },
        { graphs: facts.graphs.map((graph) => graph.canonical) },
      ),
    };
    if (deferred)
      return {
        ...basis,
        status: "deferred",
        reason:
          "Only observed purchase, fee and refund evidence books spending.",
      };
    const existing = await existingSpendingOutcome(db, { facts, basis }, page);
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
    settledLive,
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
  const categoryRefusal = reviewedCategoryRefusal({
    explicit: Boolean(request.spendingCategoryId),
    categoryId: category?.id ?? null,
    historyReviewed: request.categoryHistoryReviewed,
    historyConflict: advice?.historyConflict,
    history,
  });
  if (categoryRefusal) return review(categoryRefusal);
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
  // An explicit standalone choice (`purchaseId: null`) admits no automatic target.
  const strongTargets =
    request.purchaseId === null
      ? []
      : liveCandidates.filter((candidate) => strong.has(candidate.shortcode));
  const exact =
    !chosen && !strongTargets.length && request.purchaseId !== null
      ? await exactReceiptTarget(db, evidence)
      : undefined;
  if (exact) return prepareReadySpending(db, evidence, exact, true);
  if (
    source.kind === "refund" &&
    !chosen &&
    !strongTargets.length &&
    request.purchaseId !== null
  )
    return review("Identify the original Purchase before booking this refund.");
  // A retained-payment target wins over nearby weak candidates, as an exact
  // receipt does. Older review-only spending, or a settled Purchase that may be
  // this same charge, still needs review.
  if (
    !chosen &&
    liveCandidates.length &&
    (!strongTargets.length ||
      liveCandidates.some(
        (candidate) =>
          !strong.has(candidate.shortcode) &&
          (candidate.reviewOnly || settledLive.has(candidate.id)),
      ))
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

function loanRefundOriginalReason(
  evidence: Awaited<ReturnType<typeof discoverSpendingEvidence>>,
  target:
    | Awaited<
        ReturnType<typeof discoverSpendingEvidence>
      >["liveCandidates"][number]
    | undefined,
  loanRefund: boolean,
) {
  if (!loanRefund) return null;
  if (!target)
    return "Identify the original loan escrow disbursement before booking this refund.";
  const original = evidence.candidateEvidence.find(
    (entry) => entry.id === target.id,
  );
  const sameAccount = original?.graph.settlements.some(
    (settlement) =>
      settlement.kind === "purchase" &&
      settlement.amount > 0 &&
      settlement.status !== "void" &&
      settlement.deletedAt === null &&
      settlement.accountId === evidence.facts.account.id,
  );
  return sameAccount
    ? null
    : "The original Purchase needs a live disbursement from this loan account.";
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
): Promise<PreparedFinancialSpendingPreview> {
  const { facts, category, vendor, advice, candidateEvidence, strong, basis } =
    evidence;
  const { row, source } = facts;
  const loanRefund =
    liveHouseholdLoan(facts.account) && source.kind === "refund";
  // Category uncertainty must not invent a classification or prevent otherwise
  // supported spending. Missing effective categories enter the existing Work queue.
  const bookingCategory = bookingSpendingCategory({
    category,
    confidence: advice?.categoryConfidence,
    fromPurchase: evidence.categoryFromPurchase,
    historyReviewed: basis.request.categoryHistoryReviewed,
    historyConflict: advice?.historyConflict,
    history: evidence.history,
  });
  const review = (reason: string): FinancialSpendingPlan => ({
    ...basis,
    status: "review_required",
    reason,
  });
  const loanReason = loanRefundOriginalReason(evidence, target, loanRefund);
  if (loanReason) return review(loanReason);
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
            moneyToMinor(candidate.graph.target.statedTotal) !==
              moneyToMinor(source.amount))
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
            advice?.escrowDisbursement === true || loanRefund,
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
  if (basis.request.costType !== undefined && effect !== "create_aggregate")
    return review(
      "Cost type applies only to a new aggregate Expense; preserve existing spending classification.",
    );
  if (
    basis.request.beneficiaries !== undefined &&
    effect !== "create_aggregate"
  )
    return review(
      "Beneficiaries apply only to a new aggregate Expense; preserve existing spending attribution.",
    );
  const draft =
    effect === "create_aggregate"
      ? {
          purchaseId: target ? parseEntityId("purchase", target.id) : null,
          vendorId: vendor?.id ?? null,
          spendingCategoryId: bookingCategory?.id ?? null,
          name: source.merchant || source.rawDescription || "Reviewed spending",
        }
      : undefined;
  const beneficiaries = await readExpenseAttributionParties(
    db,
    basis.request.beneficiaries,
  );
  return {
    draft,
    finish: async (effectiveCategory) =>
      financialSpendingPlan.parse({
        ...basis,
        status: "ready",
        snapshot: await digestValue({
          snapshot: basis.snapshot,
          effectiveCategory,
          ...(basis.request.beneficiaries === undefined
            ? {}
            : { beneficiaries }),
        }),
        effect,
        purchaserId: facts.purchaser?.shortcode ?? null,
        purchaserSnapshot: await digestValue({
          account: facts.account,
          purchaserProof: facts.purchaserProof,
        }),
        vendorId: vendor?.shortcode ?? null,
        vendorName: vendor?.name ?? advice!.vendorName,
        spendingCategoryId: bookingCategory?.shortcode ?? null,
        categoryOverride:
          effect === "create_aggregate"
            ? (bookingCategory?.shortcode ?? null)
            : null,
        ...(effectiveCategory ? { effectiveCategory } : {}),
        purchaseId: target?.shortcode ?? null,
      }),
  };
}

/** The outer caller owns a single serializable retry spanning evidence and all effects. */
export async function commitFinancialSpending(
  db: Database,
  plan: FinancialSpendingPlan,
  actor: ActorContext,
  transactionId = plan.request.transactionId,
) {
  const [result] = await commitFinancialSpendings(
    db,
    [{ plan, transactionId }],
    actor,
  );
  return result ?? null;
}

type FinancialSpendingResult = { purchaseIds: string[]; replayed: boolean };

/**
 * Commit spending plans in one snapshot write: one source lock statement per
 * namespace across every transaction, one spending page read under those
 * locks, every plan rechecked against it in input order before anything is
 * written, Vendor identities resolved and created together, and every
 * resulting booking committed together. Deferred plans return null; an
 * omitted transactionId means the plan's own.
 *
 * Every plan is rechecked against the same state, so the caller must exclude
 * plans that share state within one batch: plans that settle or link the same
 * existing Purchase, and plans whose merchant or cleaned name another plan's
 * new Vendor would match. Either case refuses the whole batch.
 */
export async function commitFinancialSpendings(
  db: Database,
  entries: readonly {
    plan: FinancialSpendingPlan;
    transactionId?: FinancialTransactionShortcode | null;
  }[],
  actor: ActorContext,
): Promise<(FinancialSpendingResult | null)[]> {
  const committed: {
    index: number;
    plan: Exclude<
      FinancialSpendingPlan,
      { status: "review_required" | "deferred" }
    >;
    transactionId: FinancialTransactionShortcode;
  }[] = [];
  for (const [index, entry] of entries.entries()) {
    const { plan } = entry;
    const transactionId =
      entry.transactionId === undefined
        ? plan.request.transactionId
        : entry.transactionId;
    if (plan.status === "review_required")
      return refuse(`Spending needs review: ${plan.reason}`);
    if (plan.status === "deferred") continue;
    if (plan.status === "ready" && !plan.purchaserSnapshot)
      return refuse(
        "Spending purchaser proof is missing; refresh the booking and review again.",
      );
    if (!transactionId)
      return refuse(
        "Create the financial transaction before applying its spending plan.",
      );
    committed.push({ index, plan, transactionId });
  }
  const results: (FinancialSpendingResult | null)[] = entries.map(() => null);
  if (!committed.length) return results;
  await withSnapshotWrite(
    db,
    async (tx) => {
      const txDb = databaseForTransaction(tx);
      const targets = await lockFinancialTransactionSources(
        tx,
        committed.map((entry) => entry.transactionId),
      );
      // One page read under the locks serves every recheck; nothing is
      // written until every plan has been rechecked against it.
      const page = await prepareFinancialSpendingPage(txDb, {
        accountIds: [],
        transactionIds: targets.map((target) => target.id),
        sources: [],
      });
      await prepareFinancialSpendingCandidates(
        txDb,
        page,
        committed.flatMap(({ plan }) => {
          const name = reviewedSpendingAdvice(plan.request)?.vendorName;
          return name ? [name] : [];
        }),
      );
      const previews = await previewFinancialSpendings(
        txDb,
        committed.map(({ plan, transactionId }) => ({
          request: { ...plan.request, source: undefined, transactionId },
        })),
        page,
      );
      const written = await writeRecheckedSpendings(
        tx,
        committed,
        previews,
        page,
        actor,
      );
      for (const [position, { index }] of committed.entries())
        results[index] = written[position]!;
    },
    { isolationLevel: "serializable" },
  );
  return results;
}

/**
 * Recheck committed plans against their fresh previews, all from one
 * pre-write state, then write: retained settlements in sorted party-lock
 * order, Vendor identities together, and every booking together. The caller
 * holds each transaction's source locks in this serializable transaction and
 * previewed `fresh` on `page` there.
 */
export async function writeRecheckedSpendings(
  tx: DrizzleTransaction,
  committed: readonly {
    plan: Exclude<
      FinancialSpendingPlan,
      { status: "review_required" | "deferred" }
    >;
    transactionId: FinancialTransactionShortcode;
  }[],
  fresh: readonly FinancialSpendingPlan[],
  page: FinancialSpendingPage,
  actor: ActorContext,
  /** Every committed transaction was created in this layer. */
  layer?: WriteLayer,
): Promise<FinancialSpendingResult[]> {
  const txDb = databaseForTransaction(tx);
  const results: (FinancialSpendingResult | null)[] = committed.map(() => null);
  const rechecked = [];
  for (const [index, { plan }] of committed.entries())
    rechecked.push(
      await recheckFinancialSpending(txDb, plan, page, fresh[index]!),
    );
  const purchases = rechecked.flatMap((outcome) =>
    "fresh" in outcome && outcome.fresh.purchaseId
      ? [outcome.fresh.purchaseId]
      : [],
  );
  if (new Set(purchases).size !== purchases.length)
    return refuse(
      "Spending plans in one batch settle the same Purchase; apply them separately.",
    );
  // Retained settlement takes one per-party lock and holds it to commit.
  // Several in one batch would follow input order and could deadlock a
  // concurrent batch, so take them all first in sorted order. A single
  // settlement keeps its own lock inside the settlement writer.
  const settling = rechecked.flatMap((outcome, index) =>
    "fresh" in outcome && outcome.fresh.effect === "settle_existing"
      ? [committed[index]!]
      : [],
  );
  if (settling.length > 1) {
    const parties = await getDb(txDb)
      .select({ ledgerPartyId: financialAccount.ledgerPartyId })
      .from(financialTransaction)
      .innerJoin(
        financialAccount,
        and(
          eq(financialAccount.id, financialTransaction.accountId),
          notDeleted(financialAccount),
        ),
      )
      .where(
        and(
          inArray(
            financialTransaction.shortcode,
            settling.map((entry) => entry.transactionId),
          ),
          notDeleted(financialTransaction),
        ),
      );
    await advisoryXactLocks(
      getDb(txDb),
      "purchase-settlement",
      parties.flatMap((row) => (row.ledgerPartyId ? [row.ledgerPartyId] : [])),
    );
  }
  const booking: {
    index: number;
    fresh: Extract<FinancialSpendingPlan, { status: "ready" }>;
    facts: Awaited<ReturnType<typeof spendingFacts>>;
    transactionId: FinancialTransactionShortcode;
  }[] = [];
  for (const [index, outcome] of rechecked.entries()) {
    const { transactionId } = committed[index]!;
    if (!("fresh" in outcome)) results[index] = outcome;
    else if (outcome.fresh.effect === "settle_existing")
      results[index] = await settleFinancialSpending(txDb, tx, outcome, actor);
    else booking.push({ index, transactionId, ...outcome });
  }
  const vendors = await resolveBookingVendors(
    txDb,
    booking,
    actor,
    layer && { layer, page },
  );
  const inputs = booking.map(({ fresh, facts, transactionId }, position) =>
    financialBookingInput.parse({
      transactionId,
      purchaseId: fresh.purchaseId,
      vendorId: vendors.vendorIds[position]!,
      spendingCategoryId: fresh.spendingCategoryId,
      purchaserId: fresh.purchaserId,
      costType: financialSpendingCostType(
        facts.source.kind,
        fresh.request.costType,
      ),
      beneficiaries: fresh.request.beneficiaries,
    }),
  );
  // A supported household loan escrow disbursement, or a refund of one, is
  // the only loan spending a booking may authorize.
  const loanEscrowIds = new Set(
    booking
      .filter(
        ({ fresh, facts }) =>
          (fresh.request.advice?.escrowDisbursement === true ||
            facts.source.kind === "refund") &&
          liveHouseholdLoan(facts.account),
      )
      .map(({ transactionId }) => transactionId),
  );
  const booked = layer
    ? await bookFreshFinancialTransactions(
        layer,
        inputs,
        actor,
        await knownBookingFacts(page, vendors.ids),
        loanEscrowIds,
      )
    : await bookLockedFinancialTransactions(tx, inputs, actor, loanEscrowIds);
  for (const [position, { index }] of booking.entries()) {
    const saved = booked[position]!;
    results[index] = {
      purchaseIds: [saved.purchaseId],
      replayed: saved.replayed,
    };
  }
  return results.map((result) => {
    if (!result) throw new Error("A spending plan in the batch has no result");
    return result;
  });
}

/** The page's reads, keyed the way a booking preview reads them. */
async function knownBookingFacts(
  page: FinancialSpendingPage,
  vendorIds: ReadonlyMap<string, VendorId>,
): Promise<KnownBookingFacts> {
  const categories = new Map<string, typeof spendingCategory.$inferSelect>();
  for (const loading of page.categories.values()) {
    const category = await loading;
    if (category) {
      categories.set(category.id, category);
      categories.set(category.shortcode, category);
    }
  }
  const accounts = new Map(
    [...page.accounts.values()].map((account) => [account.id, account]),
  );
  return {
    transactions: page.transactions,
    vendorIds,
    categories,
    parties: new Map(
      [...accounts.values()].flatMap((account) =>
        account.ledgerParty
          ? [[account.ledgerParty.shortcode, account.ledgerParty] as const]
          : [],
      ),
    ),
    accounts,
    purchaserProofs: page.purchaserProofs,
    fresh: true,
  };
}

type RecheckedSpending =
  | FinancialSpendingResult
  | {
      fresh: Extract<FinancialSpendingPlan, { status: "ready" }>;
      facts: Awaited<ReturnType<typeof spendingFacts>>;
    };

/** Recheck one plan under the batch's locks and page; nothing is written. */
async function recheckFinancialSpending(
  txDb: Database,
  plan: Exclude<
    FinancialSpendingPlan,
    { status: "review_required" | "deferred" }
  >,
  page: FinancialSpendingPage,
  fresh: FinancialSpendingPlan,
): Promise<RecheckedSpending> {
  if (fresh.status === "already_booked") {
    const facts = await spendingFacts(txDb, fresh.request, page);
    if (plan.status === "already_booked" && plan.snapshot !== fresh.snapshot)
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
      const acceptedVendorCode = plan.vendorId;
      const acceptedVendor = acceptedVendorCode
        ? await getDb(txDb).query.vendor.findFirst({
            where: {
              RAW: (table: PgTable) =>
                relationalSql(
                  table,
                  and(
                    eq(vendorTable.shortcode, acceptedVendorCode),
                    notDeleted(vendorTable),
                  ),
                ),
            },
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
  return { fresh, facts: await spendingFacts(txDb, fresh.request, page) };
}

/** Write a rechecked retained settlement; later reads see current state. */
async function settleFinancialSpending(
  txDb: Database,
  tx: DrizzleTransaction,
  { fresh, facts }: Extract<RecheckedSpending, { fresh: unknown }>,
  actor: ActorContext,
): Promise<FinancialSpendingResult> {
  const purchaseId = await resolveOrThrow(txDb, "purchase", fresh.purchaseId!);
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

/**
 * Each booking's Vendor: the reviewed one, the one its plan resolved, or one
 * created now. The raw and cleaned names are checked together before any
 * Vendor is created and again after, so a Vendor created for one plan that
 * another plan's names would match refuses the batch.
 */
async function resolveBookingVendors(
  txDb: Database,
  bookings: readonly {
    fresh: Extract<FinancialSpendingPlan, { status: "ready" }>;
    facts: Awaited<ReturnType<typeof spendingFacts>>;
  }[],
  actor: ActorContext,
  /** The page this transaction read the names on, and the layer to mint in. */
  layered?: { layer: WriteLayer; page: FinancialSpendingPage },
) {
  const lookups = bookings.map(({ fresh, facts }) => {
    const merchant = issuerCardFee(facts)
      ? undefined
      : facts.source.merchant?.trim() || facts.source.rawDescription?.trim();
    return {
      merchant,
      names: [
        ...new Set(
          [merchant, fresh.vendorName].filter((value): value is string =>
            Boolean(value),
          ),
        ),
      ],
    };
  });
  const lookup = async () => {
    const results = await resolveNames(
      txDb,
      "vendor",
      lookups.flatMap(({ names }) => names.map((name) => ({ name }))),
      { create: false },
    );
    let offset = 0;
    return lookups.map(({ names }) =>
      results.slice(offset, (offset += names.length)),
    );
  };
  // The page resolved these names in this snapshot, before any own write.
  const checked = layered
    ? await Promise.all(
        lookups.map(({ names }) =>
          resolveFinancialSpendingVendors(txDb, names, layered.page),
        ),
      )
    : await lookup();
  const selectedCodes = uniq(
    bookings.flatMap(({ fresh }) =>
      fresh.request.vendorId ? [fresh.request.vendorId] : [],
    ),
  );
  const selected = new Map(
    (selectedCodes.length
      ? await getDb(txDb).query.vendor.findMany({
          where: {
            RAW: (table: PgTable) =>
              relationalSql(
                table,
                and(
                  inArray(vendorTable.shortcode, selectedCodes),
                  notDeleted(vendorTable),
                ),
              ),
          },
        })
      : []
    ).map((row) => [row.shortcode, row]),
  );
  const policyBookings = bookings.map(({ fresh }, index) => ({
    vendorId: fresh.vendorId,
    selectedCode: fresh.request.vendorId,
    name: fresh.vendorName,
    merchant: lookups[index]!.merchant,
  }));
  const plan = bookingVendorCreations(policyBookings, checked);
  if (plan.kind === "refused") return refuse(plan.reason);
  const { creating } = plan;
  const misses = plan.misses.map(({ name, aliases }) => ({
    name,
    values: async () => ({ aliases }),
  }));
  const created = layered
    ? (await mintNamesInLayer(layered.layer, "vendor", misses, actor)).map(
        (row) => ({ row, candidates: [] }),
      )
    : await resolveNames(txDb, "vendor", misses, { create: true, actor });
  const createdFor = new Map(
    creating.map((index, position) => [index, created[position]]),
  );
  const selection = bookingVendorSelection(
    policyBookings,
    checked,
    [...selected.values()],
    createdFor,
  );
  if (selection.kind === "refused") return refuse(selection.reason);
  const ids = new Map<VendorShortcode, VendorId>();
  const vendorIds = selection.rows.map((row) => {
    const code = parseShortcodeFor("vendor", row.shortcode);
    ids.set(code, parseEntityId("vendor", row.id));
    return code;
  });
  const minted = new Set(
    created.flatMap((result) =>
      result.row?.created ? [result.row.shortcode] : [],
    ),
  );
  if (minted.size) {
    const rechecked = await lookup();
    if (createdVendorConflict(rechecked, minted, vendorIds))
      return refuse(
        "The raw or cleaned Vendor identity changed before booking.",
      );
  }
  return { vendorIds, ids };
}
