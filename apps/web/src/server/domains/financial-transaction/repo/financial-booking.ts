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
import { cents, minorToMoney } from "@cubby/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { groupBy } from "es-toolkit";

import type { Database } from "~/server/db";
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
  ledgerSourceClaim,
  ledgerParty,
  financialTransaction,
  purchase,
} from "~/server/db/schema";
import { createExpense } from "~/server/domains/expense/repo/crud";
import { readExpenseAttributionParties } from "~/server/domains/expense/repo/expense-attribution";
import {
  spendingClassificationRevision,
  expenseSpendingCategoryResolutionSql,
  parseExpenseCategoryResolution,
  resolveAggregateExpenseCategory,
} from "~/server/domains/expense/repo/expense-category-resolution";
import {
  accountPurchaserKey,
  liveHouseholdCard,
  financialAccountPurchaser,
  loadAccountPurchaserProofs,
} from "~/server/domains/financial-account/repo/purchaser";
import { allocationDollars } from "~/server/domains/financial-transaction/repo/allocation-money";
import { lockFinancialTransactionSources } from "~/server/domains/financial-transaction/repo/financial-source-evidence";
import type { FinancialTransactionDollars } from "~/server/domains/financial-transaction/repo/transaction-money";
import { transactionDollars } from "~/server/domains/financial-transaction/repo/transaction-money";
import { lockLedgerPartiesForReference } from "~/server/domains/ledger-party/repo/ledger-party-reference";
import { unpricedForeignExpenseSql } from "~/server/domains/purchase-import/repo/writer-policy";
import { createPurchase } from "~/server/domains/purchase/repo/purchase";
import { merchantVendorInferenceFor } from "~/server/domains/vendor/repo/merchant-vendor-inference";
import { resolveNames } from "~/server/entity-kernel/resolve";
import { constraintViolation } from "~/server/errors/app-error";
import { recordChange } from "~/server/generic/changes/repo/change";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import { updateFinancialTransaction } from "./financial-transaction";

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
async function transactionForBooking(
  db: Database,
  input: FinancialBookingInput,
  projection?: BookingProjection,
) {
  const id = await resolveOrThrow(
    db,
    "financialTransaction",
    input.transactionId,
  );
  const stored = await getDb(db)
    .query.financialTransaction.findFirst({
      where: {
        RAW: (table: PgTable) =>
          relationalSql(
            table,
            and(
              eq(financialTransaction.id, id),
              notDeleted(financialTransaction),
            ),
          ),
      },
    })
    .then((row) => (row ? transactionDollars(row) : row));
  if (!stored)
    return constraintViolation("The financial transaction is no longer live.");
  const row = { ...stored, ...projection };
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
    where: {
      RAW: (category, { eq }) =>
        relationalSql(
          category,
          and(eq(category.id, categoryId), notDeleted(category)),
        ),
    },
  });
  if (!category && input.spendingCategoryId)
    return constraintViolation("The spending category is no longer live.");
  // Retired inherited defaults leave display unclassified; only explicit intent refuses.
  return category ?? null;
}
async function bookingAction(
  db: Database,
  input: FinancialBookingInput,
  row: Awaited<ReturnType<typeof transactionForBooking>>,
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
) {
  const input = financialBookingInput.parse(raw);
  const row = await transactionForBooking(db, input, projection);
  const merchantHistory = await resolveBookingVendor(db, input, row.merchant);
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
  if (input.purchaserId) {
    const purchaserId = await resolveOrThrow(
      db,
      "ledgerParty",
      input.purchaserId,
    );
    const member = await getDb(db).query.ledgerParty.findFirst({
      where: {
        RAW: (table: PgTable) =>
          relationalSql(
            table,
            and(eq(ledgerParty.id, purchaserId), notDeleted(ledgerParty)),
          ),
      },
    });
    if (member?.kind !== "member")
      return constraintViolation(
        "A purchaser override must name a live member LedgerParty.",
      );
  }
  const allocations = await getDb(db)
    .query.financialTransactionAllocation.findMany({
      where: {
        RAW: (allocation, { eq }) =>
          relationalSql(
            allocation,
            and(eq(allocation.transactionId, row.id), notDeleted(allocation)),
          ),
      },
      orderBy: (allocation, { asc }) => asc(allocation.purchaseId),
    })
    .then((rows) => rows.map(allocationDollars));
  if (
    allocations.length &&
    !allocations.every((allocation) => allocation.purchaseId === purchaseId)
  )
    return constraintViolation(
      "This transaction already settles another Purchase. Review that allocation before booking.",
    );
  if (
    allocations.length &&
    cents(
      allocations.reduce((sum, allocation) => sum + allocation.amount, 0),
    ) !== cents(row.amount)
  )
    return constraintViolation(
      "Existing partial allocations require reconciliation before booking.",
    );
  const capacity = await bookingAction(db, input, row, graph);
  const { action } = capacity;
  if (input.beneficiaries !== undefined && action !== "create_aggregate")
    return constraintViolation(
      "Beneficiaries apply only to a new aggregate Expense; preserve existing spending attribution.",
    );
  const beneficiaries = await readExpenseAttributionParties(
    db,
    input.beneficiaries,
  );
  const overrideId = input.spendingCategoryId
    ? await resolveOrThrow(db, "spendingCategory", input.spendingCategoryId)
    : null;
  const vendorId = input.vendorId
    ? await resolveOrThrow(db, "vendor", input.vendorId)
    : null;
  const effectiveCategory =
    action === "create_aggregate"
      ? await resolveAggregateExpenseCategory(db, {
          purchaseId,
          vendorId,
          spendingCategoryId: overrideId,
          name: row.merchant || row.rawDescription || "Reviewed spending",
        })
      : undefined;
  const existingCategories = graph.lines.length
    ? (
        await getDb(db)
          .select({
            shortcode: expense.shortcode,
            resolution: expenseSpendingCategoryResolutionSql("Expense"),
          })
          .from(expense)
          .where(and(eq(expense.purchaseId, purchaseId!), notDeleted(expense)))
          .orderBy(expense.id)
      ).map((line) => ({
        expenseId: parseShortcodeFor("expense", line.shortcode),
        resolution: parseExpenseCategoryResolution(line.resolution),
      }))
    : [];
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
  if (!purchaseId && !input.purchaserId) {
    const purchaser =
      account && financialAccountPurchaser(account, purchaserProof);
    if (!purchaser && !(account && liveHouseholdCard(account)))
      return constraintViolation(
        "Choose a live member purchaser or confirm a household credit card before creating a bare Purchase.",
      );
    input.purchaserId = purchaser
      ? parseShortcodeFor("ledgerParty", purchaser.shortcode)
      : null;
  }
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
    existingCategories,
    action,
    ...(effectiveCategory ? { effectiveCategory } : {}),
  };
  const snapshot = await digestValue({
    decision,
    row,
    graph,
    allocations,
    account,
    purchaserProof,
    category,
    merchantHistory: input.confirmsMerchant === false ? merchantHistory : null,
    classificationRevision: await spendingClassificationRevision(db),
    ...(input.beneficiaries === undefined ? {} : { beneficiaries }),
  });
  return financialBookingPreview.parse({
    ...decision,
    purchaserSnapshot: await digestValue({ account, purchaserProof }),
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
  return withSnapshotWrite(
    db,
    async (tx) => {
      const txDb = databaseForTransaction(tx);
      const replayed = await replayBooking(txDb, review);
      if (replayed) return replayed;
      await lockFinancialTransactionSources(tx, [review.transactionId]);
      await lockLedgerPartiesForReference(tx, [
        ...(review.purchaserId ? [review.purchaserId] : []),
        ...(review.beneficiaries?.flatMap((share) =>
          share.partyId ? [share.partyId] : [],
        ) ?? []),
      ]);
      const fresh = await previewFinancialBooking(txDb, {
        ...review,
        spendingCategoryId: review.categoryOverride,
      });
      if (
        JSON.stringify(fresh) !==
        JSON.stringify(financialBookingPreview.parse(review))
      )
        return constraintViolation(
          "Spending changed after this review. Preview the booking again.",
        );
      const target =
        review.purchaseId ??
        parseShortcodeFor(
          "purchase",
          (
            await createPurchase.read(
              ["id"],
              txDb,
              purchaseCreateInput.parse({
                vendorId: review.vendorId,
                defaultTrade: review.trade,
                date: fresh.date,
                displayLabel: fresh.name,
                purchaserOverrideId: review.purchaserId,
              }),
              actor,
            )
          ).output.id,
        );
      let expenseId = null;
      if (fresh.action === "create_aggregate") {
        const created = await createExpense.read(
          ["id"],
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
            beneficiaries: review.beneficiaries,
          }),
          actor,
        );
        await getDb(txDb)
          .update(expense)
          .set({ bookingTransactionCode: review.transactionId })
          .where(eq(expense.id, created.entityId));
        expenseId = parseShortcodeFor("expense", created.output.id);
      }
      await updateFinancialTransaction.read(
        ["id"],
        txDb,
        review.transactionId,
        {
          allocations: [
            {
              purchaseId: target,
              amount: fresh.amount,
              confirmsMerchant: fresh.confirmsMerchant,
            },
          ],
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
      await recordChange(txDb, {
        kind: "source",
        categories: ["purchase", "financialTransaction", "expense"],
      });
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
  return {
    lines,
    attributions,
    sourceClaims: sourceClaims.map((row) => ({
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
  };
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
  const input = financialBookingInput.parse(raw);
  const review = await previewFinancialBooking(db, input);
  return commitFinancialBooking(db, review, actor);
}
