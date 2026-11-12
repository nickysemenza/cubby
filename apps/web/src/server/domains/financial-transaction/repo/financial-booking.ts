import { createHash } from "node:crypto";

import type { ActorContext } from "@cubby/schemas/context";
import {
  financialBookingInput,
  financialBookingPreview,
  type FinancialBookingInput,
  type FinancialBookingPreview,
} from "@cubby/schemas/financial-booking";
import { purchaseSettlementKinds } from "@cubby/schemas/financial-transaction";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { expenseCreateInput } from "@cubby/schemas/project";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { cents, minorToMoney, type ShortcodeFor } from "@cubby/shared";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { groupBy, uniq } from "es-toolkit";

import type { Database } from "~/server/db";
import type { DrizzleTransaction } from "~/server/db";
import { minorToDollarsSql } from "~/server/db/computed/money";
import {
  getDb,
  notDeleted,
  withSnapshotWrite,
  databaseForTransaction,
} from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
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
  spendingClassificationRevision,
  expenseSpendingCategoryResolutionSql,
  parseExpenseCategoryResolution,
  resolveAggregateExpenseCategories,
} from "~/server/domains/expense/repo/expense-category-resolution";
import {
  accountPurchaserKey,
  liveHouseholdSpendingAccount,
  liveHouseholdLoan,
  financialAccountPurchaser,
  loadAccountPurchaserProofs,
} from "~/server/domains/financial-account/repo/purchaser";
import { allocationDollars } from "~/server/domains/financial-transaction/repo/allocation-money";
import { lockFinancialTransactionSources } from "~/server/domains/financial-transaction/repo/financial-source-evidence";
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

import { updateFinancialTransactions } from "./financial-transaction";

/** Preserve persisted JSON fingerprint bytes without a separate encoding buffer. */
export const digestValue = <T extends object>(value: T) => {
  const serialized = JSON.stringify(value);
  return Promise.resolve(
    createHash("sha256")
      .update(serialized ?? "")
      .digest("hex"),
  );
};
/** The caller emits validated canonical JSON without splitting surrogate pairs. */
export const digestCanonicalEvidenceStream = (
  writeEvidence: (write: (fragment: string) => void) => void,
) => {
  const hash = createHash("sha256");
  let buffered = '{"evidence":"';
  writeEvidence((fragment) => {
    // Escaping is additive across fragments with complete Unicode characters.
    const escaped = JSON.stringify(fragment).slice(1, -1);
    if (buffered.length + escaped.length > 32_768) {
      hash.update(buffered);
      buffered = escaped;
    } else buffered += escaped;
  });
  hash.update(buffered);
  hash.update('"}');
  return Promise.resolve(hash.digest("hex"));
};

type BookingProjection = Partial<
  Pick<FinancialTransactionDollars, "amount" | "status" | "postedDate">
>;
/** Every booking's live transaction, with one resolution and one read, in input order. */
async function transactionsForBooking(
  db: Database,
  inputs: readonly FinancialBookingInput[],
  projections: readonly (BookingProjection | undefined)[] = [],
) {
  const ids = await resolveAllOrThrow(
    db,
    "financialTransaction",
    inputs.map((input) => input.transactionId),
  );
  const stored = new Map(
    (
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
    ).map((row) => [row.id, transactionDollars(row)]),
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
  const vendorLines = graph.lines.filter(
    (line) =>
      !line.future &&
      line.economicRole === "vendor" &&
      !carriedElsewhere.has(line.id),
  );
  if (
    input.economicRole === "vendor" &&
    vendorLines.some((line) => line.cost === null)
  )
    return constraintViolation(
      "Finish pricing the existing Expense lines before linking settlement.",
    );
  if (
    input.economicRole === "vendor" &&
    vendorLines.some((line) => line.lineKind === "unclassified")
  )
    return constraintViolation(
      "Classify the unresolved receipt roles before linking settlement; their amounts may already cover this transaction.",
    );
  const negative = row.amount < 0;
  const matchingLines = vendorLines.filter((line) =>
    negative
      ? line.cost! < 0 && line.lineKind === "principal"
      : line.cost! >= 0 || line.lineKind !== "principal",
  );
  const bookedCents = matchingLines.reduce(
    (sum, line) => sum + cents(line.cost!),
    0,
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
  const settledCents = cents(previous[0]?.amount ?? 0);
  const remainingCents = negative
    ? Math.min(0, bookedCents - settledCents)
    : Math.max(0, bookedCents - settledCents);
  const remaining = Math.abs(remainingCents);
  const amount = Math.abs(cents(row.amount));
  if (input.economicRole === "vendor" && remaining > 0 && remaining < amount)
    return constraintViolation(
      "Existing Expenses cover only part of this transaction. Review the remaining amount and individual lines before booking.",
    );
  const action =
    input.economicRole === "vendor" && remaining >= amount
      ? "link_existing"
      : "create_aggregate";
  return {
    action,
    existingBookedAmount: bookedCents / 100,
    previouslySettledAmount: settledCents / 100,
    remainingBookedAmount: remainingCents / 100,
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

async function previewFinancialBookings(
  db: Database,
  raws: readonly FinancialBookingInput[],
  projections: readonly (BookingProjection | undefined)[] = [],
  loanEscrowIds: ReadonlySet<string> = new Set(),
) {
  if (!raws.length) return [];
  const inputs = raws.map((raw) => financialBookingInput.parse(raw));
  const rows = await transactionsForBooking(db, inputs, projections);
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
  const overrideIds = await resolveOptional(
    db,
    "spendingCategory",
    inputs.map((input) => input.spendingCategoryId),
  );
  const categoryIds = inputs.map(
    (_, index) =>
      overrideIds[index] ??
      graphs[index]!.target?.spendingCategoryId ??
      rows[index]!.spendingCategoryId,
  );
  const wantedCategories = uniq(categoryIds.filter((id) => id !== null));
  const liveCategories = new Map(
    (wantedCategories.length
      ? await getDb(db).query.spendingCategory.findMany({
          where: {
            RAW: (category) =>
              relationalSql(
                category,
                and(
                  inArray(spendingCategory.id, wantedCategories),
                  notDeleted(spendingCategory),
                ),
              ),
          },
        })
      : []
    ).map((category) => [category.id, category]),
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
  const vendorIds = await resolveOptional(
    db,
    "vendor",
    inputs.map((input) => input.vendorId),
  );
  const purchaserIds = await resolveOptional(
    db,
    "ledgerParty",
    inputs.map((input) => input.purchaserId),
  );
  const wantedPurchasers = uniq(purchaserIds.filter((id) => id !== null));
  const purchasers = new Map(
    (wantedPurchasers.length
      ? await getDb(db).query.ledgerParty.findMany({
          where: {
            RAW: (table: PgTable) =>
              relationalSql(
                table,
                and(
                  inArray(ledgerParty.id, wantedPurchasers),
                  notDeleted(ledgerParty),
                ),
              ),
          },
        })
      : []
    ).map((member) => [member.id, member]),
  );
  for (const purchaserId of purchaserIds)
    if (purchaserId && purchasers.get(purchaserId)?.kind !== "member")
      return constraintViolation(
        "A purchaser override must name a live member LedgerParty.",
      );
  const storedAllocations = groupBy(
    (
      await getDb(db).query.financialTransactionAllocation.findMany({
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
  const accounts = new Map(
    (
      await getDb(db).query.financialAccount.findMany({
        where: {
          RAW: (account) =>
            relationalSql(
              account,
              inArray(
                financialAccount.id,
                uniq(rows.map((row) => row.accountId)),
              ),
            ),
        },
        with: { ledgerParty: true },
      })
    ).map((account) => [account.id, account]),
  );
  const dated = rows.map((row) => ({
    account: accounts.get(row.accountId),
    date: row.transactionDate ?? row.postedDate,
  }));
  const proofs = await loadAccountPurchaserProofs(
    db,
    dated.flatMap(({ account, date }) =>
      account && !financialAccountPurchaser(account, undefined)
        ? [{ accountId: account.id, date }]
        : [],
    ),
  );
  const purchaserProofs = dated.map(({ account, date }) =>
    account && !financialAccountPurchaser(account, undefined)
      ? proofs.get(accountPurchaserKey(account.id, date))
      : undefined,
  );
  for (const [index, input] of inputs.entries()) {
    const { account } = dated[index]!;
    if (account?.identity.kind === "loan") {
      const row = rows[index]!;
      if (
        !supportedLoanEscrow({
          household: liveHouseholdLoan(account),
          authorized: loanEscrowIds.has(input.transactionId),
          kind: row.kind,
          amount: row.amount,
          purchase: Boolean(input.purchaseId),
          purchaser: Boolean(input.purchaserId),
        })
      )
        return constraintViolation(
          "Only a supported household loan escrow disbursement can book spending.",
        );
      continue;
    }
    if (purchaseIds[index] || input.purchaserId) continue;
    const purchaser =
      account && financialAccountPurchaser(account, purchaserProofs[index]);
    if (!purchaser && !liveHouseholdSpendingAccount(account))
      return constraintViolation(
        "Choose a live member purchaser or confirm a household card, bank or stored-value account before creating a bare Purchase.",
      );
    input.purchaserId = purchaser
      ? parseShortcodeFor("ledgerParty", purchaser.shortcode)
      : null;
  }
  const classificationRevision = await spendingClassificationRevision(db);
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
      classificationRevision,
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
  return previews;
}

/** Already-booked reviews replay; the rest return null. */
async function replayBookings(
  db: Database,
  reviews: readonly FinancialBookingPreview[],
) {
  const rows = await transactionsForBooking(db, reviews);
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
async function commitFinancialBookings(
  tx: DrizzleTransaction,
  reviews: readonly FinancialBookingPreview[],
  actor: ActorContext,
  current = false,
): Promise<FinancialBookingResult[]> {
  if (!reviews.length) return [];
  if (
    new Set(reviews.map((review) => review.transactionId)).size !==
    reviews.length
  )
    throw new Error("One booking batch names a transaction twice");
  const txDb = databaseForTransaction(tx);
  const results: (FinancialBookingResult | null)[] = await replayBookings(
    txDb,
    reviews,
  );
  const pending = reviews.filter((_, index) => !results[index]);
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
  const bare = pending.flatMap((review, index) =>
    review.purchaseId ? [] : [index],
  );
  const purchases = await createPurchases(
    tx,
    bare.map((index) => {
      const review = pending[index]!;
      return purchaseCreateInput.parse({
        vendorId: review.vendorId,
        defaultTrade: review.trade,
        date: fresh[index]!.date,
        displayLabel: fresh[index]!.name,
        purchaserOverrideId: review.purchaserId,
      });
    }),
    actor,
  );
  const targets = pending.map((review) => review.purchaseId);
  for (const [position, index] of bare.entries())
    targets[index] = purchases[position]!.shortcode;
  const aggregates = pending.flatMap((_, index) =>
    fresh[index]!.action === "create_aggregate" ? [index] : [],
  );
  const { created: expenses } = await createExpenses(
    txDb,
    aggregates.map((index) => {
      const review = pending[index]!;
      return expenseCreateInput.parse({
        name: fresh[index]!.name,
        cost: fresh[index]!.amount,
        date: fresh[index]!.date,
        purchaseId: targets[index],
        spendingCategoryId: review.categoryOverride,
        economicRole: review.economicRole,
        costType: review.costType,
        trade: review.trade,
        lineKind: "principal",
        lineBasis: "allocation",
        beneficiaries: review.beneficiaries,
      });
    }),
    actor,
  );
  if (expenses.length)
    await getDb(txDb)
      .update(expense)
      .set({
        bookingTransactionCode: sql`CASE ${expense.id} ${sql.join(
          expenses.map(
            (row, position) =>
              sql`WHEN ${row.id}::uuid THEN ${pending[aggregates[position]!]!.transactionId}`,
          ),
          sql` `,
        )} END`,
      })
      .where(
        inArray(
          expense.id,
          expenses.map((row) => row.id),
        ),
      );
  const expenseIds = new Map(
    aggregates.map((index, position) => [index, expenses[position]!.shortcode]),
  );
  const ids = await updateFinancialTransactions(
    txDb,
    pending.map((review, index) => ({
      shortcode: review.transactionId,
      data: {
        allocations: [
          {
            purchaseId: targets[index]!,
            amount: fresh[index]!.amount,
            confirmsMerchant: fresh[index]!.confirmsMerchant,
          },
        ],
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
  const lineages = await loadFinancialBookingLineages(
    txDb,
    pending.map((review) => review.transactionId),
  );
  const fingerprints: SQL[] = [];
  const lineageFingerprints: SQL[] = [];
  for (const [index, review] of pending.entries()) {
    const id = ids[index]!;
    fingerprints.push(
      sql`WHEN ${id}::uuid THEN ${await digestValue(financialBookingPreview.parse(review))}`,
    );
    lineageFingerprints.push(
      sql`WHEN ${id}::uuid THEN ${await digestValue(lineages.get(review.transactionId)!)}`,
    );
  }
  await getDb(txDb)
    .update(financialTransaction)
    .set({
      bookingDecisionFingerprint: sql`CASE ${financialTransaction.id} ${sql.join(fingerprints, sql` `)} END`,
      bookingExpenseFingerprint: sql`CASE ${financialTransaction.id} ${sql.join(lineageFingerprints, sql` `)} END`,
    })
    .where(inArray(financialTransaction.id, ids));
  await recordChange(txDb, {
    kind: "source",
    categories: ["purchase", "financialTransaction", "expense"],
  });
  return settled();
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
async function loadFinancialBookingLineages(
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
    .orderBy(expense.id);
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
    .orderBy(expenseAttribution.id);
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
    .orderBy(ledgerSourceClaim.id);
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
export async function bookFinancialTransactions(
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
      const reviews = await previewFinancialBookings(
        databaseForTransaction(tx),
        raws,
        [],
        loanEscrowIds,
      );
      return commitFinancialBookings(tx, reviews, actor, true);
    },
    { isolationLevel: "serializable" },
  );
}
