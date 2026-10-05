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
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  expense,
  expenseAttribution,
  ledgerSourceClaim,
  financialTransaction,
  purchase,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { cents } from "~/server/repo/money";
import { refreshDerivedSearchRefs } from "~/server/services/mutation-side-effects";

import {
  getDb,
  notDeleted,
  withTransaction,
  databaseForTransaction,
} from "./database-helpers";
import { spendingClassificationRevision } from "./expense-category-resolution";
import { createExpense } from "./expense/crud";
import { lockFinancialEvidenceKeys } from "./financial-evidence";
import { updateFinancialTransaction } from "./financial-transaction";
import { createPurchase } from "./purchase";
import { resolveOrThrow } from "./shortcode-resolver";

export async function digestValue<T extends object>(value: T) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
const fail = (message: string): never => {
  throw createAppError("CONSTRAINT_VIOLATION", message);
};
async function transactionForBooking(
  db: Database,
  input: FinancialBookingInput,
) {
  const id = await resolveOrThrow(
    db,
    "financialTransaction",
    input.transactionId,
  );
  const row = await getDb(db).query.financialTransaction.findFirst({
    where: and(
      eq(financialTransaction.id, id),
      notDeleted(financialTransaction),
    ),
  });
  if (!row) return fail("The financial transaction is no longer live.");
  if (
    row.status !== "posted" ||
    row.ledgerTransferId ||
    !purchaseSettlementKinds.some((kind) => kind === row.kind)
  )
    return fail(
      "Only posted spending can be booked. Transfer evidence is not spending.",
    );
  if (row.kind === "income" && input.economicRole !== "reimbursement")
    return fail(
      "Classify this incoming credit explicitly as a reimbursement before booking it.",
    );
  if (input.economicRole === "reimbursement" && row.amount >= 0)
    return fail("A reimbursement must be an incoming credit.");
  return row;
}
async function bookingGraph(
  db: Database,
  purchaseId: typeof purchase.$inferSelect.id | null,
) {
  if (!purchaseId) return { target: null, lines: [], attributions: [] };
  const target = await getDb(db).query.purchase.findFirst({
    where: and(eq(purchase.id, purchaseId), notDeleted(purchase)),
  });
  if (!target) return fail("The selected Purchase is no longer live.");
  const lines = await getDb(db)
    .select()
    .from(expense)
    .where(and(eq(expense.purchaseId, purchaseId), notDeleted(expense)))
    .orderBy(expense.id);
  const attributions = await getDb(db)
    .select()
    .from(expenseAttribution)
    .innerJoin(expense, eq(expense.id, expenseAttribution.expenseId))
    .where(
      and(
        eq(expense.purchaseId, purchaseId),
        notDeleted(expense),
        notDeleted(expenseAttribution),
      ),
    )
    .orderBy(expenseAttribution.id);
  return { target, lines, attributions };
}
async function bookingCategory(
  db: Database,
  input: FinancialBookingInput,
  inheritedCategoryId: typeof purchase.$inferSelect.spendingCategoryId,
) {
  const categoryId = input.spendingCategoryId
    ? await resolveOrThrow(db, "spendingCategory", input.spendingCategoryId)
    : inheritedCategoryId;
  if (!categoryId) return null;
  const category = await getDb(db).query.spendingCategory.findFirst({
    where: (category, { eq }) =>
      and(eq(category.id, categoryId), notDeleted(category)),
  });
  if (!category && input.spendingCategoryId)
    return fail("The spending category is no longer live.");
  // Retired inherited defaults leave display unclassified; only explicit intent refuses.
  return category ?? null;
}
async function bookingAction(
  db: Database,
  input: FinancialBookingInput,
  row: Awaited<ReturnType<typeof transactionForBooking>>,
  graph: Awaited<ReturnType<typeof bookingGraph>>,
) {
  const vendorLines = graph.lines.filter(
    (line) => !line.future && line.economicRole === "vendor",
  );
  if (
    input.economicRole === "vendor" &&
    vendorLines.some((line) => line.cost === null)
  )
    return fail(
      "Finish pricing the existing Expense lines before linking settlement.",
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
          amount: sql<number>`COALESCE(SUM(a.amount), 0)`.mapWith(Number),
        })
        .from(
          sql`"FinancialTransactionAllocation" a JOIN "FinancialTransaction" f ON f.id = a."transactionId"`,
        )
        .where(
          sql`a."purchaseId" = ${graph.target.id} AND a."deletedAt" IS NULL AND f."deletedAt" IS NULL AND f.status <> 'void' AND f."ledgerTransferId" IS NULL AND f.kind <> 'income' AND f.id <> ${row.id} AND SIGN(a.amount) = SIGN(${row.amount}::numeric) AND NOT EXISTS (SELECT 1 FROM "Expense" e WHERE e."bookingTransactionCode" = f.shortcode AND e."deletedAt" IS NULL AND e."economicRole" = 'reimbursement')`,
        )
    : [];
  const settledCents = cents(previous[0]?.amount ?? 0);
  const remainingCents = negative
    ? Math.min(0, bookedCents - settledCents)
    : Math.max(0, bookedCents - settledCents);
  const remaining = Math.abs(remainingCents);
  const amount = Math.abs(cents(row.amount));
  if (input.economicRole === "vendor" && remaining > 0 && remaining < amount)
    return fail(
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
export async function previewFinancialBooking(
  db: Database,
  raw: FinancialBookingInput,
) {
  const input = financialBookingInput.parse(raw);
  const row = await transactionForBooking(db, input);
  if (!input.purchaseId && !input.vendorId)
    return fail("Choose the vendor or an existing Purchase before booking.");
  const purchaseId = input.purchaseId
    ? await resolveOrThrow(db, "purchase", input.purchaseId)
    : null;
  const graph = await bookingGraph(db, purchaseId);
  const category = await bookingCategory(
    db,
    input,
    graph.target?.spendingCategoryId ?? row.spendingCategoryId,
  );
  if (input.vendorId) await resolveOrThrow(db, "vendor", input.vendorId);
  const allocations = await getDb(
    db,
  ).query.financialTransactionAllocation.findMany({
    where: (allocation, { eq }) =>
      and(eq(allocation.transactionId, row.id), notDeleted(allocation)),
    orderBy: (allocation, { asc }) => asc(allocation.purchaseId),
  });
  if (
    allocations.length &&
    !allocations.every((allocation) => allocation.purchaseId === purchaseId)
  )
    return fail(
      "This transaction already settles another Purchase. Review that allocation before booking.",
    );
  const capacity = await bookingAction(db, input, row, graph);
  const { action } = capacity;
  const account = await getDb(db).query.financialAccount.findFirst({
    where: (account, { eq }) => eq(account.id, row.accountId),
    with: { ledgerParty: true },
  });
  const decision = {
    ...input,
    categoryOverride: input.spendingCategoryId,
    spendingCategoryId: category
      ? parseShortcodeFor("spendingCategory", category.shortcode)
      : null,
    action,
  };
  const snapshot = await digestValue({
    decision,
    row,
    graph,
    allocations,
    account,
    category,
    classificationRevision: await spendingClassificationRevision(db),
  });
  return financialBookingPreview.parse({
    ...decision,
    snapshot,
    accountName: account?.name ?? "Account",
    funderName: account?.ledgerParty?.name ?? null,
    ...capacity,
    amount: row.amount,
    date: row.transactionDate ?? row.postedDate,
    name: row.merchant || row.rawDescription || "Reviewed spending",
  });
}
async function replayBooking(db: Database, review: FinancialBookingPreview) {
  const row = await transactionForBooking(db, review);
  if (!row.bookingDecisionFingerprint) return null;
  if (
    row.bookingDecisionFingerprint !==
      (await digestValue(financialBookingPreview.parse(review))) ||
    row.amount !== review.amount
  )
    return fail(
      "This transaction already has a different reviewed booking. Review its existing Expenses.",
    );
  const allocations = await getDb(
    db,
  ).query.financialTransactionAllocation.findMany({
    where: (allocation, { eq }) =>
      and(eq(allocation.transactionId, row.id), notDeleted(allocation)),
  });
  const allocation = allocations[0];
  if (
    allocations.length !== 1 ||
    !allocation ||
    cents(allocation.amount) !== cents(row.amount)
  )
    return fail("The approved booking allocation changed.");
  const graph = await bookingGraph(db, allocation.purchaseId);
  if (!review.purchaseId && review.vendorId) {
    const vendorId = await resolveOrThrow(db, "vendor", review.vendorId);
    if (graph.target?.vendorId !== vendorId)
      return fail("The approved vendor changed.");
  }
  if (review.purchaseId && graph.target?.shortcode !== review.purchaseId)
    return fail("The approved Purchase changed.");
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
    return fail("The approved booking lineage changed.");
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
  return withTransaction(
    db,
    async (tx) => {
      await lockFinancialEvidenceKeys(tx, "reviewed-booking", [
        review.transactionId,
      ]);
      const txDb = databaseForTransaction(tx);
      const replayed = await replayBooking(txDb, review);
      if (replayed) return replayed;
      const fresh = await previewFinancialBooking(txDb, {
        ...review,
        spendingCategoryId: review.categoryOverride,
      });
      if (
        JSON.stringify(fresh) !==
        JSON.stringify(financialBookingPreview.parse(review))
      )
        return fail(
          "Spending changed after this review. Preview the booking again.",
        );
      const target =
        review.purchaseId ??
        (
          await createPurchase(
            txDb,
            purchaseCreateInput.parse({
              vendorId: review.vendorId,
              defaultTrade: review.trade,
              date: fresh.date,
              displayLabel: fresh.name,
            }),
            actor,
          )
        ).output.id;
      let expenseId = null;
      if (fresh.action === "create_aggregate") {
        const created = await createExpense(
          txDb,
          expenseCreateInput.parse({
            name: fresh.name,
            cost: fresh.amount,
            date: fresh.date,
            purchaseId: target,
            spendingCategoryId: review.categoryOverride,
            economicRole: review.economicRole,
            costType: review.costType,
            trade: review.trade,
            lineKind: "principal",
            lineBasis: "allocation",
          }),
          actor,
        );
        await getDb(txDb)
          .update(expense)
          .set({ bookingTransactionCode: review.transactionId })
          .where(eq(expense.id, created.entityId));
        expenseId = created.output.id;
      }
      await updateFinancialTransaction(
        txDb,
        review.transactionId,
        {
          allocations: [{ purchaseId: target, amount: fresh.amount }],
        },
        actor,
      );
      const id = await resolveOrThrow(
        txDb,
        "financialTransaction",
        review.transactionId,
      );
      await getDb(txDb)
        .update(financialTransaction)
        .set({
          bookingDecisionFingerprint: await digestValue(
            financialBookingPreview.parse(review),
          ),
          bookingExpenseFingerprint: await digestValue(
            await loadFinancialBookingLineage(txDb, review.transactionId),
          ),
        })
        .where(eq(financialTransaction.id, id));
      await refreshDerivedSearchRefs(
        txDb,
        [
          {
            entityKind: "purchase",
            entityId: await resolveOrThrow(txDb, "purchase", target),
          },
          { entityKind: "financialTransaction", entityId: id },
          ...(expenseId
            ? [
                {
                  entityKind: "expense" as const,
                  entityId: await resolveOrThrow(txDb, "expense", expenseId),
                },
              ]
            : []),
        ],
        "financialTransaction.commitBooking",
      );
      return { purchaseId: target, expenseId, replayed: false };
    },
    { isolationLevel: "serializable" },
  );
}

export async function loadFinancialBookingLineage(
  db: Database,
  transactionCode: FinancialBookingInput["transactionId"],
) {
  const lines = await getDb(db)
    .select()
    .from(expense)
    .where(
      and(
        eq(expense.bookingTransactionCode, transactionCode),
        notDeleted(expense),
      ),
    )
    .orderBy(expense.id);
  const attributions = await getDb(db)
    .select()
    .from(expenseAttribution)
    .innerJoin(expense, eq(expense.id, expenseAttribution.expenseId))
    .where(
      and(
        eq(expense.bookingTransactionCode, transactionCode),
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
        eq(expense.bookingTransactionCode, transactionCode),
        notDeleted(expense),
        notDeleted(ledgerSourceClaim),
      ),
    )
    .orderBy(ledgerSourceClaim.id);
  return { lines, attributions, sourceClaims };
}
