import type { ActorContext } from "@cubby/schemas/context";
import {
  financialBookingInput,
  financialBookingPreview,
  type FinancialBookingInput,
  type FinancialBookingPreview,
} from "@cubby/schemas/financial-booking";
import { purchaseSettlementKinds } from "@cubby/schemas/financial-transaction";
import {
  type FinancialTransactionId,
  parseShortcodeFor,
  type VendorId,
} from "@cubby/schemas/identifiers";
import { expenseCreateInput } from "@cubby/schemas/project";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import {
  cents,
  moneyToMinor,
  minorToMoney,
  nullableMinorToMoney,
  type ShortcodeFor,
} from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { groupBy, uniq } from "es-toolkit";

import type { Database } from "~/server/db";
import type { DrizzleTransaction } from "~/server/db";
import { minorToDollarsSql } from "~/server/db/computed/money";
import {
  getDb,
  notDeleted,
  unwrapDb,
  withSnapshotWrite,
  databaseForTransaction,
} from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import { requestedRows } from "~/server/db/helpers/requested";
import {
  expense,
  expenseAttribution,
  financialAccount,
  financialTransactionAllocation,
  ledgerSourceClaim,
  ledgerParty,
  financialTransaction,
  purchase,
  spendingCategory,
} from "~/server/db/schema";
import { createExpenses } from "~/server/domains/expense/repo/crud";
import { readExpenseAttributionParties } from "~/server/domains/expense/repo/expense-attribution";
import {
  expenseSpendingCategoryResolutionSql,
  parseExpenseCategoryResolution,
  resolveAggregateExpenseCategories,
} from "~/server/domains/expense/repo/expense-category-resolution";
import {
  accountPurchaserKey,
  liveHouseholdSpendingAccount,
  liveHouseholdLoan,
  financialAccountPurchaser,
} from "~/server/domains/financial-account/policy/purchaser";
import { loadAccountPurchaserProofs } from "~/server/domains/financial-account/repo/purchaser";
import { bookingAction as decideBookingAction } from "~/server/domains/financial-transaction/policy/booking-action";
import { digestValue } from "~/server/domains/financial-transaction/policy/booking-fingerprint";
import { statementBookingRows } from "~/server/domains/financial-transaction/policy/booking-rows";
import { allocationDollars } from "~/server/domains/financial-transaction/repo/allocation-money";
import { lockFinancialTransactionSources } from "~/server/domains/financial-transaction/repo/financial-source-evidence";
import { updatePurchaseEventWhere } from "~/server/domains/financial-transaction/repo/purchase-event-mutations";
import type { FinancialTransactionDollars } from "~/server/domains/financial-transaction/repo/transaction-money";
import { transactionDollars } from "~/server/domains/financial-transaction/repo/transaction-money";
import { lockLedgerPartiesForReference } from "~/server/domains/ledger-party/repo/ledger-party-reference";
import { unpricedForeignExpenseSql } from "~/server/domains/purchase-import/repo/writer-policy";
import { createPurchases } from "~/server/domains/purchase/repo/purchase";
import { merchantVendorInferenceFor } from "~/server/domains/vendor/repo/merchant-vendor-inference";
import { resolveNames } from "~/server/entity-kernel/resolve";
import { constraintViolation } from "~/server/errors/app-error";
import { recordChange } from "~/server/generic/changes/repo/change";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/generic/shortcode/repo/shortcode-resolver";

import { allocateFinancialBookings } from "./financial-transaction";

type BookingProjection = Partial<
  Pick<FinancialTransactionDollars, "amount" | "status" | "postedDate">
>;
/** Every booking's live transaction, with one resolution and one read, in input order. */
async function transactionsForBooking(
  db: Database,
  inputs: readonly FinancialBookingInput[],
  projections: readonly (BookingProjection | undefined)[] = [],
  /** Live rows by code, read in this snapshot as this function reads them. */
  known?: ReadonlyMap<string, FinancialTransactionDollars>,
) {
  const knownRows =
    known && inputs.every((input) => known.has(input.transactionId))
      ? inputs.map((input) => known.get(input.transactionId)!)
      : null;
  const ids = knownRows
    ? knownRows.map((row) => row.id)
    : await resolveAllOrThrow(
        db,
        "financialTransaction",
        inputs.map((input) => input.transactionId),
      );
  const stored = new Map(
    knownRows
      ? knownRows.map((row) => [row.id, row] as const)
      : (
          await getDb(db).query.financialTransaction.findMany({
            where: {
              RAW: (table: PgTable) =>
                relationalSql(
                  table,
                  and(
                    inArray(financialTransaction.id, ids),
                    notDeleted(financialTransaction),
                  ),
                ),
            },
          })
        ).map((row) => [row.id, transactionDollars(row)] as const),
  );
  return inputs.map((input, index) => {
    const live = stored.get(ids[index]!);
    if (!live)
      return constraintViolation(
        "The financial transaction is no longer live.",
      );
    const row = { ...live, ...projections[index] };
    if (
      row.status === "void" ||
      row.status === "expected" ||
      row.ledgerTransferId ||
      !purchaseSettlementKinds.some((kind) => kind === row.kind)
    )
      return constraintViolation(
        "Only observed spending can be booked. Transfer evidence is not spending.",
      );
    if (row.kind === "income" && input.economicRole !== "reimbursement")
      return constraintViolation(
        "Classify this incoming credit explicitly as a reimbursement before booking it.",
      );
    if (input.economicRole === "reimbursement" && row.amount >= 0)
      return constraintViolation("A reimbursement must be an incoming credit.");
    return row;
  });
}

/** Optional shortcodes resolved in one statement, in input order. */
async function resolveOptional<
  E extends "purchase" | "spendingCategory" | "vendor" | "ledgerParty",
>(db: Database, entity: E, codes: readonly (string | null | undefined)[]) {
  const ids = await resolveAllOrThrow(
    db,
    entity,
    codes.filter((code): code is string => Boolean(code)),
  );
  let index = 0;
  return codes.map((code) => (code ? ids[index++]! : null));
}

export async function bookingGraph(
  db: Database,
  purchaseId: typeof purchase.$inferSelect.id | null,
) {
  if (!purchaseId) return { target: null, lines: [], attributions: [] };
  const graph = (await bookingGraphs(db, [purchaseId])).get(purchaseId);
  if (!graph)
    return constraintViolation("The selected Purchase is no longer live.");
  return graph;
}

/** Retained booking fingerprints keep Expense cost on the dollar-number wire. */
const dollarExpense = (row: typeof expense.$inferSelect) => ({
  ...row,
  cost: nullableMinorToMoney(row.cost),
});
const dollarJoinedExpense = <
  T extends { Expense: typeof expense.$inferSelect },
>(
  row: T,
): Omit<T, "Expense"> & { Expense: ReturnType<typeof dollarExpense> } => ({
  ...row,
  Expense: dollarExpense(row.Expense),
});

/** Read-only page preparation; authoritative booking still loads its current graph. */
export async function bookingGraphs(
  db: Database,
  purchaseIds: readonly (typeof purchase.$inferSelect.id)[],
) {
  const ids = [...new Set(purchaseIds)];
  const storedTargets = ids.length
    ? await getDb(db).query.purchase.findMany({
        where: {
          RAW: (table: PgTable) =>
            relationalSql(
              table,
              and(inArray(purchase.id, ids), notDeleted(purchase)),
            ),
        },
      })
    : [];
  // Retained booking fingerprints keep their original dollar-number shape.
  const targets = storedTargets.map((row) => ({
    ...row,
    statedTotal:
      row.statedTotal === null ? null : minorToMoney(row.statedTotal),
  }));
  const lines = ids.length
    ? await getDb(db)
        .select()
        .from(expense)
        .where(and(inArray(expense.purchaseId, ids), notDeleted(expense)))
        .orderBy(expense.id)
        .then((rows) => rows.map(dollarExpense))
    : [];
  const attributions = ids.length
    ? await getDb(db)
        .select()
        .from(expenseAttribution)
        .innerJoin(expense, eq(expense.id, expenseAttribution.expenseId))
        .where(
          and(
            inArray(expense.purchaseId, ids),
            notDeleted(expense),
            notDeleted(expenseAttribution),
          ),
        )
        .orderBy(expenseAttribution.id)
        .then((rows) => rows.map(dollarJoinedExpense))
    : [];
  const linesByPurchase = groupBy(lines, (line) => line.purchaseId ?? "");
  const attributionsByPurchase = groupBy(
    attributions,
    (entry) => entry.Expense.purchaseId ?? "",
  );
  return new Map(
    targets.map((target) => [
      target.id,
      {
        target,
        lines: linesByPurchase[target.id] ?? [],
        attributions: attributionsByPurchase[target.id] ?? [],
      },
    ]),
  );
}
async function bookingAction(
  db: Database,
  input: FinancialBookingInput,
  row: Awaited<ReturnType<typeof transactionsForBooking>>[number],
  graph: Awaited<ReturnType<typeof bookingGraph>>,
) {
  // Unpriced item lines whose money a source-backed aggregate carries (foreign
  // receipts, total-only USD itemizations) neither block nor count toward settlement.
  const pendingUnpriced = graph.lines.filter((line) => line.cost === null);
  const carriedElsewhere = new Set(
    pendingUnpriced.length
      ? (
          await getDb(db)
            .select({ id: expense.id })
            .from(expense)
            .where(
              and(
                inArray(
                  expense.id,
                  pendingUnpriced.map((line) => line.id),
                ),
                unpricedForeignExpenseSql({
                  id: sql`${expense.id}`,
                  purchaseId: sql`${expense.purchaseId}`,
                  lineKind: sql`${expense.lineKind}`,
                  cost: sql`${expense.cost}`,
                }),
              ),
            )
        ).map((line) => line.id)
      : [],
  );
  const previous = graph.target
    ? await getDb(db)
        .select({
          amount:
            sql<number>`COALESCE(SUM((${minorToDollarsSql(sql`a."amountMinor"`, "numeric")})), 0)`.mapWith(
              Number,
            ),
        })
        .from(
          sql`"FinancialTransactionAllocation" a JOIN "FinancialTransaction" f ON f.id = a."transactionId"`,
        )
        .where(
          sql`a."purchaseId" = ${graph.target.id} AND ${notDeleted("a")} AND ${notDeleted("f")} AND f.status <> 'void' AND f."ledgerTransferId" IS NULL AND f.kind <> 'income' AND f.id <> ${row.id} AND SIGN((${minorToDollarsSql(sql`a."amountMinor"`, "numeric")})) = SIGN(${row.amount}::numeric) AND NOT EXISTS (SELECT 1 FROM "Expense" e WHERE e."bookingTransactionCode" = f.shortcode AND ${notDeleted("e")} AND e."economicRole" = 'reimbursement')`,
        )
    : [];
  const decision = decideBookingAction({
    economicRole: input.economicRole,
    transactionAmountMinor: moneyToMinor(row.amount),
    expenses: graph.lines.map((line) => ({
      ...line,
      costMinor: line.cost === null ? null : moneyToMinor(line.cost),
      carriedElsewhere: carriedElsewhere.has(line.id),
    })),
    previouslySettledMinor: moneyToMinor(previous[0]?.amount ?? 0),
  });
  if (decision.kind === "refused") return constraintViolation(decision.reason);
  return {
    action: decision.action,
    existingBookedAmount: minorToMoney(decision.existingBookedMinor),
    previouslySettledAmount: minorToMoney(decision.previouslySettledMinor),
    remainingBookedAmount: minorToMoney(decision.remainingBookedMinor),
  };
}
/** Resolve an omitted Vendor and carry inference authority into the booking snapshot. */
async function resolveBookingVendor(
  db: Database,
  input: FinancialBookingInput,
  merchant: string | null,
) {
  const merchantHistory =
    merchant &&
    !input.purchaseId &&
    (!input.vendorId || input.confirmsMerchant === false)
      ? await merchantVendorInferenceFor(db, merchant)
      : null;
  if (!input.purchaseId && !input.vendorId && merchantHistory) {
    if (merchantHistory.status === "suggested") {
      input.vendorId = merchantHistory.candidates[0].vendorId;
      input.confirmsMerchant = false;
    }
  }
  if (
    !input.purchaseId &&
    !input.vendorId &&
    merchantHistory?.status === "ambiguous"
  )
    return constraintViolation(
      "This statement label identifies several Vendors; choose the Vendor or an existing Purchase before booking.",
    );
  if (
    !input.purchaseId &&
    !input.vendorId &&
    input.economicRole === "reimbursement"
  ) {
    const merchantLabel = merchant?.trim();
    if (!merchantLabel)
      return constraintViolation(
        "This transaction names no merchant; pass vendorId or purchaseId to book it.",
      );
    const [named] = await resolveNames(
      db,
      "vendor",
      [{ name: merchantLabel }],
      {
        create: false,
      },
    );
    if (!named?.row)
      return constraintViolation(
        `No Vendor is named "${merchantLabel}" by name or alias; pass vendorId or purchaseId to book it.`,
      );
    if (named.candidates.length > 0)
      return constraintViolation(
        `Merchant "${merchantLabel}" matches ${[named.row, ...named.candidates].map(({ shortcode }) => shortcode).join(", ")}; pass the intended vendorId.`,
      );
    input.vendorId = parseShortcodeFor("vendor", named.row.shortcode);
    input.confirmsMerchant = false;
  }
  if (!input.purchaseId && !input.vendorId)
    return constraintViolation(
      "Choose the vendor or an existing Purchase before booking.",
    );
  return merchantHistory;
}

export async function previewFinancialBooking(
  db: Database,
  raw: FinancialBookingInput,
  projection?: BookingProjection,
  loanEscrow = false,
) {
  const [preview] = await previewFinancialBookings(
    db,
    [raw],
    [projection],
    loanEscrow ? new Set([raw.transactionId]) : undefined,
  );
  return preview!;
}

/**
 * Preview several bookings against the same state: each read takes one
 * statement for the whole set, and each preview equals its own single
 * preview. Bookings that share state must not be previewed together for one
 * commit (see `bookFinancialTransactions`).
 */
function supportedLoanEscrow(input: {
  household: boolean;
  authorized: boolean;
  kind: string;
  amount: number;
  purchase: boolean;
  purchaser: boolean;
}) {
  return (
    input.household &&
    input.authorized &&
    !input.purchaser &&
    ((input.kind === "purchase" && input.amount > 0) ||
      (input.kind === "refund" && input.amount < 0 && input.purchase))
  );
}

/**
 * Settle a booking's purchaser before preview: a loan books only an authorized
 * household escrow disbursement or its refund; a bare Purchase needs a live
 * member purchaser or a household card, bank or stored-value account.
 */
function assignBookingPurchaser(
  input: FinancialBookingInput,
  account: Parameters<typeof liveHouseholdSpendingAccount>[0],
  row: { kind: string; amount: number },
  linked: boolean,
  proof: Parameters<typeof financialAccountPurchaser>[1],
  loanEscrowIds: ReadonlySet<string>,
): string | null {
  if (account?.identity.kind === "loan")
    return loanBookingSupported(account, row, input, loanEscrowIds)
      ? null
      : "Only a supported household loan escrow disbursement can book spending.";
  if (linked || input.purchaserId) return null;
  const purchaser = account && financialAccountPurchaser(account, proof);
  if (!purchaser && !liveHouseholdSpendingAccount(account))
    return "Choose a live member purchaser or confirm a household card, bank or stored-value account before creating a bare Purchase.";
  input.purchaserId = purchaser
    ? parseShortcodeFor("ledgerParty", purchaser.shortcode)
    : null;
  return null;
}

/** A loan account books only an authorized household escrow disbursement or its refund. */
function loanBookingSupported(
  account: Parameters<typeof liveHouseholdLoan>[0],
  row: { kind: string; amount: number },
  input: Pick<
    FinancialBookingInput,
    "transactionId" | "purchaseId" | "purchaserId"
  >,
  loanEscrowIds: ReadonlySet<string>,
) {
  return supportedLoanEscrow({
    household: liveHouseholdLoan(account),
    authorized: loanEscrowIds.has(input.transactionId),
    kind: row.kind,
    amount: row.amount,
    purchase: Boolean(input.purchaseId),
    purchaser: Boolean(input.purchaserId),
  });
}

async function previewFinancialBookings(
  db: Database,
  raws: readonly FinancialBookingInput[],
  projections: readonly (BookingProjection | undefined)[] = [],
  loanEscrowIds: ReadonlySet<string> = new Set(),
) {
  return (
    await prepareBookingPreviews(
      db,
      raws,
      projections,
      undefined,
      loanEscrowIds,
    )
  ).previews;
}

/** Previews with the transaction rows they read, for a commit in the same snapshot. */
/**
 * Facts this transaction already read the way a booking preview reads them,
 * so the preview reuses them instead of reading again. A missing entry falls
 * back to the read.
 */
export type KnownBookingFacts = {
  transactions: ReadonlyMap<string, FinancialTransactionDollars>;
  vendorIds: ReadonlyMap<string, VendorId>;
  /** Live categories by code and by id. */
  categories: ReadonlyMap<string, typeof spendingCategory.$inferSelect>;
  /** The accounts' live parties by code; a purchaser may be another party. */
  parties: ReadonlyMap<string, typeof ledgerParty.$inferSelect>;
  /** Accounts with their LedgerParty, by id. */
  accounts: ReadonlyMap<
    string,
    Awaited<ReturnType<typeof loadBookingAccounts>>[number]
  >;
  purchaserProofs: Awaited<ReturnType<typeof loadAccountPurchaserProofs>>;
  /** Every named transaction was created in this transaction. */
  fresh: true;
};

const loadBookingAccounts = (db: Database, ids: readonly string[]) =>
  getDb(db).query.financialAccount.findMany({
    where: {
      RAW: (account) =>
        relationalSql(
          account,
          // SAFETY: account ids come from stored transaction rows.
          inArray(financialAccount.id, ids as never[]),
        ),
    },
    with: { ledgerParty: true },
  });

/** Each code's known value, or null when any code must be read. */
const knownCodes = <T>(
  codes: readonly (string | null | undefined)[],
  known: ReadonlyMap<string, T> | undefined,
) =>
  known && codes.every((code) => !code || known.has(code))
    ? codes.map((code) => (code ? known.get(code)! : null))
    : null;

async function liveBookingCategories(
  db: Database,
  wanted: readonly string[],
  known: KnownBookingFacts | undefined,
) {
  const knownCategories = knownCodes(wanted, known?.categories);
  return new Map(
    (knownCategories
      ? knownCategories.flatMap((category) => (category ? [category] : []))
      : wanted.length
        ? await getDb(db).query.spendingCategory.findMany({
            where: {
              RAW: (category) =>
                relationalSql(
                  category,
                  and(
                    // SAFETY: wanted ids come from resolved or stored category references.
                    inArray(spendingCategory.id, wanted as never[]),
                    notDeleted(spendingCategory),
                  ),
                ),
            },
          })
        : []
    ).map((category) => [category.id, category]),
  );
}

/** Each purchaser override's party id, and the live parties by id. */
async function bookingPurchasers(
  db: Database,
  codes: readonly (string | null | undefined)[],
  known: KnownBookingFacts | undefined,
) {
  const knownParties = knownCodes(codes, known?.parties);
  const purchaserIds =
    knownParties?.map((party) => party?.id ?? null) ??
    (await resolveOptional(db, "ledgerParty", codes));
  const wanted = uniq(purchaserIds.filter((id) => id !== null));
  const purchasers = new Map(
    (knownParties
      ? knownParties.flatMap((party) => (party ? [party] : []))
      : wanted.length
        ? await getDb(db).query.ledgerParty.findMany({
            where: {
              RAW: (table: PgTable) =>
                relationalSql(
                  table,
                  and(inArray(ledgerParty.id, wanted), notDeleted(ledgerParty)),
                ),
            },
          })
        : []
    ).map((member) => [member.id, member]),
  );
  return { purchaserIds, purchasers };
}

/** Each row's account and date, and the purchaser proof for those dates. */
async function bookingAccountProofs(
  db: Database,
  rows: readonly FinancialTransactionDollars[],
  known: KnownBookingFacts | undefined,
) {
  const accountIds = uniq(rows.map((row) => row.accountId));
  const knownAccounts = knownCodes(accountIds, known?.accounts);
  const accounts = new Map(
    (
      knownAccounts?.flatMap((account) => (account ? [account] : [])) ??
      (await loadBookingAccounts(db, accountIds))
    ).map((account) => [account.id, account]),
  );
  const dated = rows.map((row) => ({
    account: accounts.get(row.accountId),
    date: row.transactionDate ?? row.postedDate,
  }));
  const needed = dated.flatMap(({ account, date }) =>
    account && !financialAccountPurchaser(account, undefined)
      ? [{ accountId: account.id, date }]
      : [],
  );
  const proofs =
    known &&
    needed.every(({ accountId, date }) =>
      known.purchaserProofs.has(accountPurchaserKey(accountId, date)),
    )
      ? known.purchaserProofs
      : await loadAccountPurchaserProofs(db, needed);
  return { dated, proofs };
}

async function prepareBookingPreviews(
  db: Database,
  raws: readonly FinancialBookingInput[],
  projections: readonly (BookingProjection | undefined)[] = [],
  known?: KnownBookingFacts,
  loanEscrowIds: ReadonlySet<string> = new Set(),
) {
  if (!raws.length) return { previews: [], rows: [] };
  const inputs = raws.map((raw) => financialBookingInput.parse(raw));
  const rows = await transactionsForBooking(
    db,
    inputs,
    projections,
    known?.transactions,
  );
  const merchantHistories = [];
  for (const [index, input] of inputs.entries())
    merchantHistories.push(
      await resolveBookingVendor(db, input, rows[index]!.merchant),
    );
  const purchaseIds = await resolveOptional(
    db,
    "purchase",
    inputs.map((input) => input.purchaseId),
  );
  const loadedGraphs = await bookingGraphs(
    db,
    purchaseIds.filter((id) => id !== null),
  );
  const graphs = purchaseIds.map((purchaseId) => {
    if (!purchaseId) return { target: null, lines: [], attributions: [] };
    const graph = loadedGraphs.get(purchaseId);
    if (!graph)
      return constraintViolation("The selected Purchase is no longer live.");
    return graph;
  });
  const overrideIds =
    knownCodes(
      inputs.map((input) => input.spendingCategoryId),
      known?.categories,
    )?.map((category) => category?.id ?? null) ??
    (await resolveOptional(
      db,
      "spendingCategory",
      inputs.map((input) => input.spendingCategoryId),
    ));
  const categoryIds = inputs.map(
    (_, index) =>
      overrideIds[index] ??
      graphs[index]!.target?.spendingCategoryId ??
      rows[index]!.spendingCategoryId,
  );
  const liveCategories = await liveBookingCategories(
    db,
    uniq(categoryIds.filter((id) => id !== null)),
    known,
  );
  const categories = inputs.map((input, index) => {
    const categoryId = categoryIds[index];
    if (!categoryId) return null;
    const category = liveCategories.get(categoryId);
    if (!category && input.spendingCategoryId)
      return constraintViolation("The spending category is no longer live.");
    // Retired inherited defaults leave display unclassified; only explicit intent refuses.
    return category ?? null;
  });
  const vendorIds =
    knownCodes(
      inputs.map((input) => input.vendorId),
      known?.vendorIds,
    ) ??
    (await resolveOptional(
      db,
      "vendor",
      inputs.map((input) => input.vendorId),
    ));
  const { purchaserIds, purchasers } = await bookingPurchasers(
    db,
    inputs.map((input) => input.purchaserId),
    known,
  );
  for (const purchaserId of purchaserIds)
    if (purchaserId && purchasers.get(purchaserId)?.kind !== "member")
      return constraintViolation(
        "A purchaser override must name a live member LedgerParty.",
      );
  const storedAllocations = groupBy(
    (known?.fresh
      ? []
      : await getDb(db).query.financialTransactionAllocation.findMany({
          where: {
            RAW: (allocation) =>
              relationalSql(
                allocation,
                and(
                  inArray(
                    financialTransactionAllocation.transactionId,
                    uniq(rows.map((row) => row.id)),
                  ),
                  notDeleted(financialTransactionAllocation),
                ),
              ),
          },
          orderBy: (allocation, { asc }) => asc(allocation.purchaseId),
        })
    ).map(allocationDollars),
    (allocation) => allocation.transactionId,
  );
  const allocations = rows.map((row) => storedAllocations[row.id] ?? []);
  const capacities: Awaited<ReturnType<typeof bookingAction>>[] = [];
  for (const [index, input] of inputs.entries()) {
    const purchaseId = purchaseIds[index];
    const held = allocations[index]!;
    if (
      held.length &&
      !held.every((allocation) => allocation.purchaseId === purchaseId)
    )
      return constraintViolation(
        "This transaction already settles another Purchase. Review that allocation before booking.",
      );
    if (
      held.length &&
      cents(held.reduce((sum, allocation) => sum + allocation.amount, 0)) !==
        cents(rows[index]!.amount)
    )
      return constraintViolation(
        "Existing partial allocations require reconciliation before booking.",
      );
    const capacity = await bookingAction(
      db,
      input,
      rows[index]!,
      graphs[index]!,
    );
    if (
      input.beneficiaries !== undefined &&
      capacity.action !== "create_aggregate"
    )
      return constraintViolation(
        "Beneficiaries apply only to a new aggregate Expense; preserve existing spending attribution.",
      );
    capacities.push(capacity);
  }
  const beneficiaries = [];
  for (const input of inputs)
    beneficiaries.push(
      await readExpenseAttributionParties(db, input.beneficiaries),
    );
  const aggregates = inputs.flatMap((_, index) =>
    capacities[index]!.action === "create_aggregate" ? [index] : [],
  );
  const resolvedCategories = await resolveAggregateExpenseCategories(
    db,
    aggregates.map((index) => {
      const row = rows[index]!;
      return {
        purchaseId: purchaseIds[index]!,
        vendorId: vendorIds[index]!,
        spendingCategoryId: overrideIds[index]!,
        name: row.merchant || row.rawDescription || "Reviewed spending",
      };
    }),
  );
  const effectiveCategories = new Map(
    aggregates.map((index, position) => [index, resolvedCategories[position]!]),
  );
  const existingCategories = [];
  for (const [index, graph] of graphs.entries())
    existingCategories.push(
      graph.lines.length
        ? (
            await getDb(db)
              .select({
                shortcode: expense.shortcode,
                resolution: expenseSpendingCategoryResolutionSql("Expense"),
              })
              .from(expense)
              .where(
                and(
                  eq(expense.purchaseId, purchaseIds[index]!),
                  notDeleted(expense),
                ),
              )
              .orderBy(expense.id)
          ).map((line) => ({
            expenseId: parseShortcodeFor("expense", line.shortcode),
            resolution: parseExpenseCategoryResolution(line.resolution),
          }))
        : [],
    );
  const { dated, proofs } = await bookingAccountProofs(db, rows, known);
  const purchaserProofs = dated.map(({ account, date }) =>
    account && !financialAccountPurchaser(account, undefined)
      ? proofs.get(accountPurchaserKey(account.id, date))
      : undefined,
  );
  for (const [index, input] of inputs.entries()) {
    const refusal = assignBookingPurchaser(
      input,
      dated[index]!.account,
      rows[index]!,
      Boolean(purchaseIds[index]),
      purchaserProofs[index],
      loanEscrowIds,
    );
    if (refusal) return constraintViolation(refusal);
  }
  const classificationRevisions = await bookingClassificationRevisions(
    db,
    inputs.map((_, index) =>
      [vendorIds[index], graphs[index]!.target?.vendorId].filter(
        (id): id is NonNullable<typeof id> => Boolean(id),
      ),
    ),
  );
  const previews = [];
  for (const [index, input] of inputs.entries()) {
    const row = rows[index]!;
    const category = categories[index]!;
    const capacity = capacities[index]!;
    const effectiveCategory = effectiveCategories.get(index);
    const { account } = dated[index]!;
    const purchaserProof = purchaserProofs[index];
    const decision = {
      // Reparse after inference so optional keys have the same order on commit replay.
      ...financialBookingInput.parse(input),
      categoryOverride: input.spendingCategoryId,
      spendingCategoryId: category
        ? parseShortcodeFor("spendingCategory", category.shortcode)
        : null,
      candidateCategoryId: category
        ? parseShortcodeFor("spendingCategory", category.shortcode)
        : null,
      existingCategories: existingCategories[index]!,
      action: capacity.action,
      ...(effectiveCategory ? { effectiveCategory } : {}),
    };
    const snapshot = await digestValue({
      decision,
      row,
      graph: graphs[index]!,
      allocations: allocations[index]!,
      account,
      purchaserProof,
      category,
      merchantHistory:
        input.confirmsMerchant === false ? merchantHistories[index] : null,
      classificationRevision: classificationRevisions[index]!,
      ...(input.beneficiaries === undefined
        ? {}
        : { beneficiaries: beneficiaries[index] }),
    });
    previews.push(
      financialBookingPreview.parse({
        ...decision,
        purchaserSnapshot: await digestValue({ account, purchaserProof }),
        snapshot,
        accountName: account?.name ?? "Account",
        funderName: account?.ledgerParty?.name ?? null,
        ...capacity,
        amount: row.amount,
        date: row.transactionDate ?? row.postedDate,
        name: row.merchant || row.rawDescription || "Reviewed spending",
      }),
    );
  }
  return { previews, rows };
}

/**
 * Each booking's classification policy revision: the live spending
 * categories, the Product category mappings, and the booking's own Vendors
 * (its Vendor and its target Purchase's Vendor). Every preview and commit path
 * uses this one definition; a policy change to another Vendor cannot change
 * this booking, so it is not part of its snapshot.
 */
async function bookingClassificationRevisions(
  db: Database,
  vendorSets: readonly (readonly string[])[],
): Promise<string[]> {
  if (!vendorSets.length) return [];
  const wanted = requestedRows(
    vendorSets.flatMap((vendors, ordinal) =>
      vendors.map((vendor) => ({ ordinal, vendor })),
    ),
    { ordinal: "int", vendor: "uuid" },
    "wanted",
  );
  const rows = await unwrapDb(db).execute<{ ordinal: number; policy: unknown }>(
    sql`
    WITH policy AS (
      SELECT
        (SELECT jsonb_agg(jsonb_build_array(id,name,"parentId") ORDER BY id) FROM "SpendingCategory" WHERE ${notDeleted("SpendingCategory")}) AS categories,
        (SELECT jsonb_agg(jsonb_build_array(id,"parentId",feature,"spendingCategoryMode","spendingCategoryId") ORDER BY id) FROM "ProductCategory" WHERE ${notDeleted("ProductCategory")}) AS mappings
    )
    SELECT booking.ordinal, jsonb_build_object(
      'categories', policy.categories,
      'mappings', policy.mappings,
      'vendors', (
        SELECT jsonb_agg(jsonb_build_array(v.id,v."spendingProfile",v."defaultSpendingCategoryId") ORDER BY v.id)
        FROM "Vendor" v
        WHERE v.id IN (SELECT ${wanted.col("vendor")} FROM ${wanted.from} WHERE ${wanted.col("ordinal")} = booking.ordinal)
          AND ${notDeleted("v")}
      )) AS policy
    FROM generate_series(0, ${vendorSets.length - 1}) AS booking(ordinal), policy
    ORDER BY booking.ordinal`,
    "objects",
  );
  return Promise.all(rows.map((row) => sha256Hex(JSON.stringify(row.policy))));
}

/** Already-booked reviews replay; the rest return null. */
async function replayBookings(
  db: Database,
  reviews: readonly FinancialBookingPreview[],
  rows: Awaited<ReturnType<typeof transactionsForBooking>>,
) {
  const results = [];
  for (const [index, review] of reviews.entries())
    results.push(await replayBooking(db, review, rows[index]!));
  return results;
}

async function replayBooking(
  db: Database,
  review: FinancialBookingPreview,
  row: Awaited<ReturnType<typeof transactionsForBooking>>[number],
) {
  if (!row.bookingDecisionFingerprint) return null;
  if (
    row.bookingDecisionFingerprint !==
      (await digestValue(financialBookingPreview.parse(review))) ||
    row.amount !== review.amount
  )
    return constraintViolation(
      "This transaction already has a different reviewed booking. Review its existing Expenses.",
    );
  const account = await getDb(db).query.financialAccount.findFirst({
    where: {
      RAW: (account, { eq }) =>
        relationalSql(account, eq(account.id, row.accountId)),
    },
    with: { ledgerParty: true },
  });
  const date = row.transactionDate ?? row.postedDate;
  const purchaserProof =
    account && !financialAccountPurchaser(account, undefined)
      ? (
          await loadAccountPurchaserProofs(db, [
            { accountId: account.id, date },
          ])
        ).get(accountPurchaserKey(account.id, date))
      : undefined;
  // Unknown remains unknown across access/owner changes; compare its proof too.
  if (
    review.purchaserSnapshot !==
    (await digestValue({ account, purchaserProof }))
  )
    return constraintViolation(
      "The approved account or purchaser evidence changed.",
    );
  const allocations = await getDb(db)
    .query.financialTransactionAllocation.findMany({
      where: {
        RAW: (allocation, { eq }) =>
          relationalSql(
            allocation,
            and(eq(allocation.transactionId, row.id), notDeleted(allocation)),
          ),
      },
    })
    .then((rows) => rows.map(allocationDollars));
  const allocation = allocations[0];
  if (
    allocations.length !== 1 ||
    !allocation ||
    cents(allocation.amount) !== cents(row.amount)
  )
    return constraintViolation("The approved booking allocation changed.");
  const graph = await bookingGraph(db, allocation.purchaseId);
  if (review.action === "link_existing") {
    const capacity = await bookingAction(db, review, row, graph);
    if (capacity.action !== "link_existing")
      return constraintViolation(
        "Existing itemized spending no longer covers the approved settlement.",
      );
  }
  if (!review.purchaseId && review.vendorId) {
    const vendorId = await resolveOrThrow(db, "vendor", review.vendorId);
    if (graph.target?.vendorId !== vendorId)
      return constraintViolation("The approved vendor changed.");
  }
  if (review.purchaseId && graph.target?.shortcode !== review.purchaseId)
    return constraintViolation("The approved Purchase changed.");
  const lineage = graph.lines.filter(
    (line) => line.bookingTransactionCode === review.transactionId,
  );
  if (
    review.action === "create_aggregate" &&
    (!lineage.length ||
      lineage.some(
        (line) =>
          line.cost === null || line.economicRole !== review.economicRole,
      ) ||
      lineage.reduce((sum, line) => sum + cents(line.cost ?? 0), 0) !==
        cents(row.amount))
  )
    return constraintViolation("The approved booking lineage changed.");
  return {
    purchaseId: parseShortcodeFor("purchase", graph.target!.shortcode),
    expenseId: lineage[0]
      ? parseShortcodeFor("expense", lineage[0].shortcode)
      : null,
    replayed: true,
  };
}
export async function commitFinancialBooking(
  db: Database,
  review: FinancialBookingPreview,
  actor: ActorContext,
) {
  const [saved] = await withSnapshotWrite(
    db,
    (tx) => commitFinancialBookings(tx, [review], actor),
    { isolationLevel: "serializable" },
  );
  return saved!;
}

type FinancialBookingResult = {
  purchaseId: ShortcodeFor<"purchase">;
  expenseId: ShortcodeFor<"expense"> | null;
  replayed: boolean;
};

/**
 * Commit reviewed bookings inside the caller's snapshot write. Replays are
 * read first; the remaining bookings take their source and party locks
 * together, are previewed again under them unless `current` says the caller
 * previewed them in this transaction after the same source locks, and then
 * write their Purchases, Expenses, allocations and fingerprints as one set.
 */
function bookingRowIntents(review: FinancialBookingPreview) {
  return statementBookingRows({
    charge: {
      transactionId: review.transactionId,
      amountMinor: moneyToMinor(review.amount),
      date: review.date,
      name: review.name,
    },
    purchaseId: review.purchaseId,
    purchaserId: review.purchaserId,
    vendorId: review.vendorId,
    categoryOverride: review.categoryOverride,
    economicRole: review.economicRole,
    costType: review.costType,
    trade: review.trade,
    beneficiaries: review.beneficiaries,
    confirmsMerchant: review.confirmsMerchant,
    remainingBookedMinor: moneyToMinor(review.remainingBookedAmount),
  });
}

function bookingExpenseWire(
  intent: NonNullable<ReturnType<typeof statementBookingRows>["expense"]>,
  purchaseId: string | null | undefined,
) {
  const {
    costMinor,
    attributions,
    beneficiariesSpecified,
    bookingTransactionCode: _bookingTransactionCode,
    ...fields
  } = intent;
  return expenseCreateInput.parse({
    ...fields,
    cost: minorToMoney(costMinor),
    purchaseId,
    ...(beneficiariesSpecified
      ? {
          beneficiaries: attributions.map(({ partyId, weight }) => ({
            partyId,
            weight,
          })),
        }
      : {}),
  });
}

async function commitFinancialBookings(
  tx: DrizzleTransaction,
  reviews: readonly FinancialBookingPreview[],
  actor: ActorContext,
  current = false,
  /** The preview's rows when `current`: same snapshot, same order. */
  previewed?: Awaited<ReturnType<typeof transactionsForBooking>>,
): Promise<FinancialBookingResult[]> {
  if (!reviews.length) return [];
  if (
    new Set(reviews.map((review) => review.transactionId)).size !==
    reviews.length
  )
    throw new Error("One booking batch names a transaction twice");
  const txDb = databaseForTransaction(tx);
  const rows = previewed ?? (await transactionsForBooking(txDb, reviews));
  const results: (FinancialBookingResult | null)[] = await replayBookings(
    txDb,
    reviews,
    rows,
  );
  const pending = reviews.filter((_, index) => !results[index]);
  const pendingRows = rows.filter((_, index) => !results[index]);
  const settled = () =>
    results.map((result) => {
      if (!result) throw new Error("A booking in the batch has no result");
      return result;
    });
  if (!pending.length) return settled();
  if (!current)
    await lockFinancialTransactionSources(
      tx,
      pending.map((review) => review.transactionId),
    );
  await lockLedgerPartiesForReference(
    tx,
    pending.flatMap((review) => [
      ...(review.purchaserId ? [review.purchaserId] : []),
      ...(review.beneficiaries?.flatMap((share) =>
        share.partyId ? [share.partyId] : [],
      ) ?? []),
    ]),
  );
  const fresh = current
    ? pending
    : await previewFinancialBookings(
        txDb,
        pending.map((review) => ({
          ...review,
          spendingCategoryId: review.categoryOverride,
        })),
      );
  for (const [index, review] of pending.entries())
    if (
      JSON.stringify(fresh[index]) !==
      JSON.stringify(financialBookingPreview.parse(review))
    )
      return constraintViolation(
        "Spending changed after this review. Preview the booking again.",
      );
  const intents = fresh.map(bookingRowIntents);
  const bare = intents.flatMap((intent, index) =>
    intent.purchaseReference.kind === "existing" ? [] : [index],
  );
  const purchases = await createPurchases(
    tx,
    bare.map((index) => purchaseCreateInput.parse(intents[index]!.purchase)),
    actor,
  );
  const targets = intents.map((intent) =>
    intent.purchaseReference.kind === "existing"
      ? intent.purchaseReference.purchaseId
      : null,
  );
  for (const [position, index] of bare.entries())
    targets[index] = parseShortcodeFor(
      "purchase",
      purchases[position]!.shortcode,
    );
  const aggregates = pending.flatMap((_, index) =>
    intents[index]!.expense ? [index] : [],
  );
  const { created: expenses } = await createExpenses(
    txDb,
    aggregates.map((index) =>
      bookingExpenseWire(intents[index]!.expense!, targets[index]),
    ),
    actor,
  );
  if (expenses.length)
    await updatePurchaseEventWhere(
      txDb,
      "expense",
      {
        bookingTransactionCode: sql`CASE ${expense.id} ${sql.join(
          expenses.map(
            (row, position) =>
              sql`WHEN ${row.id}::uuid THEN ${pending[aggregates[position]!]!.transactionId}`,
          ),
          sql` `,
        )} END`,
      },
      inArray(
        expense.id,
        expenses.map((row) => row.id),
      ),
      actor,
    );
  const expenseIds = new Map(
    aggregates.map((index, position) => [
      index,
      parseShortcodeFor("expense", expenses[position]!.shortcode),
    ]),
  );
  const ids = await allocateFinancialBookings(
    tx,
    pending.map((_, index) => ({
      row: pendingRows[index]!,
      allocation: {
        purchaseId: targets[index]!,
        amount: minorToMoney(intents[index]!.allocation.amountMinor),
        confirmsMerchant: intents[index]!.allocation.confirmsMerchant,
      },
    })),
    actor,
  );
  let position = 0;
  for (const [index, result] of results.entries())
    if (!result) {
      const pendingIndex = position++;
      results[index] = {
        purchaseId: targets[pendingIndex]!,
        expenseId: expenseIds.get(pendingIndex) ?? null,
        replayed: false,
      };
    }
  await writeBookingFingerprints(
    txDb,
    pending,
    ids,
    await loadFinancialBookingLineages(
      txDb,
      pending.map((review) => review.transactionId),
    ),
  );
  return settled();
}

/** Store each booking's decision and lineage fingerprints and announce the change. */
async function writeBookingFingerprints(
  db: Database,
  reviews: readonly FinancialBookingPreview[],
  ids: readonly FinancialTransactionId[],
  lineages: ReadonlyMap<string, object>,
) {
  const fingerprints: SQL[] = [];
  const lineageFingerprints: SQL[] = [];
  for (const [index, review] of reviews.entries()) {
    const id = ids[index]!;
    fingerprints.push(
      sql`WHEN ${id}::uuid THEN ${await digestValue(financialBookingPreview.parse(review))}`,
    );
    lineageFingerprints.push(
      sql`WHEN ${id}::uuid THEN ${await digestValue(lineages.get(review.transactionId)!)}`,
    );
  }
  await getDb(db)
    .update(financialTransaction)
    .set({
      bookingDecisionFingerprint: sql`CASE ${financialTransaction.id} ${sql.join(fingerprints, sql` `)} END`,
      bookingExpenseFingerprint: sql`CASE ${financialTransaction.id} ${sql.join(lineageFingerprints, sql` `)} END`,
    })
    .where(inArray(financialTransaction.id, [...ids]));
  await recordChange(db, {
    kind: "source",
    categories: ["purchase", "financialTransaction", "expense"],
  });
}

export async function loadFinancialBookingLineage(
  db: Database,
  transactionCode: FinancialBookingInput["transactionId"],
) {
  return (await loadFinancialBookingLineages(db, [transactionCode])).get(
    transactionCode,
  )!;
}

/** Each transaction's booked Expense lineage, read in three statements. */
export async function loadFinancialBookingLineages(
  db: Database,
  transactionCodes: readonly FinancialBookingInput["transactionId"][],
) {
  const codes = uniq(transactionCodes);
  const lines = await getDb(db)
    .select()
    .from(expense)
    .where(
      and(inArray(expense.bookingTransactionCode, codes), notDeleted(expense)),
    )
    .orderBy(expense.id)
    .then((rows) => rows.map(dollarExpense));
  const attributions = await getDb(db)
    .select()
    .from(expenseAttribution)
    .innerJoin(expense, eq(expense.id, expenseAttribution.expenseId))
    .where(
      and(
        inArray(expense.bookingTransactionCode, codes),
        notDeleted(expense),
        notDeleted(expenseAttribution),
      ),
    )
    .orderBy(expenseAttribution.id)
    .then((rows) => rows.map(dollarJoinedExpense));
  const sourceClaims = await getDb(db)
    .select()
    .from(ledgerSourceClaim)
    .innerJoin(expense, eq(expense.id, ledgerSourceClaim.expenseId))
    .where(
      and(
        inArray(expense.bookingTransactionCode, codes),
        notDeleted(expense),
        notDeleted(ledgerSourceClaim),
      ),
    )
    .orderBy(ledgerSourceClaim.id)
    .then((rows) => rows.map(dollarJoinedExpense));
  return new Map(
    codes.map((code) => [
      code,
      {
        lines: lines.filter((line) => line.bookingTransactionCode === code),
        attributions: attributions.filter(
          (row) => row.Expense.bookingTransactionCode === code,
        ),
        sourceClaims: sourceClaims
          .filter((row) => row.Expense.bookingTransactionCode === code)
          .map((row) => ({
            ...row,
            // Preserve predecessor fingerprint key order and dollar values; storage bigint never enters JSON.
            LedgerSourceClaim: Object.fromEntries(
              Object.entries(row.LedgerSourceClaim).map(([key, value]) =>
                key === "targetAmountMinor"
                  ? [
                      "targetAmountAtClaim",
                      minorToMoney(row.LedgerSourceClaim.targetAmountMinor),
                    ]
                  : [key, value],
              ),
            ),
          })),
      },
    ]),
  );
}

/**
 * `finance.book_transaction`: preview and commit one booking in a single call.
 * A reimbursement naming neither Purchase nor Vendor books into a new lump
 * Purchase for the Vendor its merchant names exactly (name or alias); an
 * unknown merchant is refused rather than inventing a Vendor.
 */
export async function bookFinancialTransaction(
  db: Database,
  raw: FinancialBookingInput,
  actor: ActorContext,
) {
  const [saved] = await bookFinancialTransactions(db, [raw], actor);
  return saved!;
}

/**
 * Preview and commit bookings together in one snapshot write: the source
 * locks come first, every preview reads the same state, and the writes follow
 * as one set without previewing again.
 *
 * Every preview runs before any write, so the caller must exclude bookings
 * that share state within one batch: bookings that settle or link the same
 * existing Purchase (an earlier booking changes the later preview's capacity
 * and graph) and bookings that need the same not-yet-existing Vendor. The
 * first case refuses the whole batch.
 */
async function bookFinancialTransactions(
  db: Database,
  raws: readonly FinancialBookingInput[],
  actor: ActorContext,
  loanEscrowIds: ReadonlySet<string> = new Set(),
) {
  if (!raws.length) return [];
  const purchases = raws.flatMap((raw) =>
    raw.purchaseId ? [raw.purchaseId] : [],
  );
  if (new Set(purchases).size !== purchases.length)
    return constraintViolation(
      "One booking batch names the same Purchase twice; book them separately.",
    );
  return withSnapshotWrite(
    db,
    async (tx) => {
      await lockFinancialTransactionSources(
        tx,
        raws.map((raw) => raw.transactionId),
      );
      return bookLockedFinancialTransactions(tx, raws, actor, loanEscrowIds);
    },
    { isolationLevel: "serializable" },
  );
}

/**
 * `bookFinancialTransactions` inside the caller's serializable transaction,
 * which already holds every named transaction's source locks.
 */
export async function bookLockedFinancialTransactions(
  tx: DrizzleTransaction,
  raws: readonly FinancialBookingInput[],
  actor: ActorContext,
  loanEscrowIds: ReadonlySet<string> = new Set(),
) {
  if (!raws.length) return [];
  const purchases = raws.flatMap((raw) =>
    raw.purchaseId ? [raw.purchaseId] : [],
  );
  if (new Set(purchases).size !== purchases.length)
    return constraintViolation(
      "One booking batch names the same Purchase twice; book them separately.",
    );
  const { previews, rows } = await prepareBookingPreviews(
    databaseForTransaction(tx),
    raws,
    [],
    undefined,
    loanEscrowIds,
  );
  return commitFinancialBookings(tx, previews, actor, true, rows);
}
