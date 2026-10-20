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
import { and, eq, sql } from "drizzle-orm";
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
import { effectiveExpenseSpendingCategorySql } from "~/server/domains/expense/repo/expense-category-resolution";
import { lockFinancialEvidenceKeys } from "~/server/domains/financial-transaction/repo/financial-evidence";
import {
  planPurchaseRetainedSettlement,
  settlePurchaseFromRetainedPayments,
} from "~/server/domains/purchase-import/repo/retained-settlement";
import { resolveNames } from "~/server/entity-kernel/resolve";
import { AppError, createAppError } from "~/server/errors/app-error";
import { settlementRefsFor } from "~/server/generic/entity-links/repo/entity-external-ids";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { canonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";

import {
  bookFinancialTransaction,
  bookingGraph,
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
  category: typeof spendingCategory.$inferSelect | undefined;
  history: { category: string | null }[];
  vendorResolved: boolean;
  ambiguous: boolean;
  categoryHistoryReviewed?: boolean;
}) {
  const { facts, advice, category, history } = input;
  if (
    !facts.account.ledgerParty ||
    facts.account.ledgerParty.kind !== "member" ||
    facts.account.ledgerParty.deletedAt ||
    facts.account.provisional
  )
    return "A confirmed member account owner is required before booking spending.";
  if (
    !(facts.source.transactionDate ?? facts.source.postedDate) ||
    !facts.source.sourceRefs.length
  )
    return "A dated, stable source identity is required before booking spending.";
  if (input.ambiguous)
    return "The merchant matches competing Vendors; review its identity.";
  if (
    !category ||
    advice?.categoryConfidence !== "high" ||
    (advice.historyConflict && !input.categoryHistoryReviewed)
  )
    return "Choose one well-supported live spending category before booking.";
  if (
    !input.categoryHistoryReviewed &&
    history.some(
      (entry) => entry.category !== null && entry.category !== category.id,
    )
  )
    return "Merchant spending history conflicts with the proposed category.";
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

async function spendingFacts(db: Database, request: Request) {
  const row = request.transactionId
    ? await getDb(db).query.financialTransaction.findFirst({
        where: and(
          eq(financialTransaction.shortcode, request.transactionId),
          notDeleted(financialTransaction),
        ),
      })
    : undefined;
  if (request.transactionId && !row)
    refuse("The spending transaction is no longer live.");
  const account = await getDb(db).query.financialAccount.findFirst({
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
        accountId: account.shortcode,
        sourceRefs: (await settlementRefsFor(db, [row.id])).get(row.id) ?? [],
      })
    : financialSpendingSource.parse(request.source);
  source.sourceRefs.sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.externalId.localeCompare(b.externalId),
  );
  const allocations = row
    ? await getDb(db).query.financialTransactionAllocation.findMany({
        where: and(
          eq(financialTransactionAllocation.transactionId, row.id),
          notDeleted(financialTransactionAllocation),
        ),
        orderBy: financialTransactionAllocation.purchaseId,
      })
    : [];
  const graphs = [];
  for (const allocation of allocations)
    graphs.push(await spendingGraph(db, allocation.purchaseId));
  return { row, source, account, allocations, graphs };
}

/** Capacity includes other settlements and effective categories, not just a signed line. */
async function spendingGraph(
  db: Database,
  purchaseId: Parameters<typeof bookingGraph>[1],
) {
  const graph = await bookingGraph(db, purchaseId);
  const categories = (
    await getDb(db).execute<{ id: string; category: string | null }>(sql`
    SELECT e.id, ${effectiveExpenseSpendingCategorySql("e")} AS category FROM "Expense" e
    WHERE e."purchaseId" = ${purchaseId} AND e."deletedAt" IS NULL ORDER BY e.id
  `)
  ).rows;
  const settlements = (
    await getDb(db).execute<{
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
    }>(sql`SELECT a."transactionId", f.shortcode AS "transactionCode", a.amount, f.kind, f.status, f."deletedAt", f."ledgerTransferId",
    f.amount AS "transactionAmount", fa."deletedAt" AS "accountDeletedAt",
    (SELECT sum(coverage.amount) FROM "FinancialTransactionAllocation" coverage
      WHERE coverage."transactionId" = f.id AND coverage."deletedAt" IS NULL) AS "allocatedAmount",
    to_jsonb(f) AS transaction, to_jsonb(fa) AS account, to_jsonb(lp) AS owner
    FROM "FinancialTransactionAllocation" a JOIN "FinancialTransaction" f ON f.id = a."transactionId"
    JOIN "FinancialAccount" fa ON fa.id = f."accountId"
    LEFT JOIN "LedgerParty" lp ON lp.id = fa."ledgerPartyId"
    WHERE a."purchaseId" = ${purchaseId} AND a."deletedAt" IS NULL ORDER BY a."transactionId", a.id
  `)
  ).rows;
  return { ...graph, categories, settlements };
}

function availableCents(
  graph: Awaited<ReturnType<typeof spendingGraph>>,
  amount: number,
  currentId?: string,
) {
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
        entry.status !== "posted" ||
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
    SELECT ${effectiveExpenseSpendingCategorySql("e")} AS category, c.name, count(*)::int AS lines
    FROM "Expense" e JOIN "Purchase" p ON p.id=e."purchaseId"
    LEFT JOIN "SpendingCategory" c ON c.id=${effectiveExpenseSpendingCategorySql("e")} AND c."deletedAt" IS NULL
    WHERE p."vendorId"=${vendorId} AND p."deletedAt" IS NULL AND e."deletedAt" IS NULL AND NOT e.future
    GROUP BY ${effectiveExpenseSpendingCategorySql("e")}, c.name ORDER BY category NULLS FIRST
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

/** Discovery does not authorize a write; the same retained evidence is rebuilt at commit. */
async function discoverSpendingEvidence(
  db: Database,
  request: Request,
  facts: Awaited<ReturnType<typeof spendingFacts>>,
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
  const resolved = names.length
    ? await resolveNames(
        db,
        "vendor",
        names.map((name) => ({ name })),
        { create: false },
      )
    : [];
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
    ? await getDb(db).query.spendingCategory.findFirst({
        where: and(
          eq(spendingCategory.shortcode, advice.spendingCategoryId),
          notDeleted(spendingCategory),
        ),
      })
    : undefined;
  const date = source.transactionDate ?? source.postedDate;
  // Retained payment dates use UTC calendar days, matching the shared matcher.
  const candidates = date
    ? (
        await getDb(db).execute<{
          id: string;
          shortcode: string;
          displayLabel: string | null;
          date: string | null;
        }>(sql`SELECT p.id, p.shortcode, p."displayLabel", p.date FROM "Purchase" p
    WHERE p."deletedAt" IS NULL
      AND (p.shortcode = ${request.purchaseId ?? null} OR (p."vendorId" = ${vendor?.id ?? null}::uuid AND ${source.kind !== "refund"} AND abs(p.date - ${date}::date) <= 14) OR EXISTS (
        SELECT 1 FROM "PurchasePaymentEvidence" payment WHERE payment."purchaseId" = p.id
          AND round(payment.amount * 100) = ${cents(source.amount)}
          AND abs(payment."chargedAt"::date - ${date}::date) <= 3))
    ORDER BY p.id`)
      ).rows
    : [];
  const rejected = new Set(request.rejectedPurchaseIds);
  const liveCandidates = candidates.filter(
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
    source.status === "posted" &&
    ["purchase", "fee", "refund"].includes(source.kind)
  ) {
    // UTC noon carries a plain calendar date to the retained-payment matcher.
    const charge = {
      id: row?.id ?? "prospective",
      kind: source.kind,
      amount: source.amount,
      occurredAt: new Date(`${date}T12:00:00.000Z`),
      cardLastFours: cardLastFoursOn(account.cardNumbers, date),
      storedValue: account.identity.kind === "stored_value",
    };
    for (const candidate of liveCandidates) {
      const plan = await planPurchaseRetainedSettlement(getDb(db), {
        purchaseId: parseEntityId("purchase", candidate.id),
        ledgerPartyId: account.ledgerPartyId!,
        additionalCharges: [charge],
        discovery: true,
      });
      if (
        Array.isArray(plan) &&
        plan.some((entry) => entry.charge.id === charge.id)
      )
        strong.set(candidate.shortcode, plan);
    }
  }
  const history = vendor
    ? await financialSpendingCategoryHistory(db, vendor.id)
    : [];
  const candidateEvidence = [];
  for (const candidate of liveCandidates)
    candidateEvidence.push({
      ...candidate,
      graph: await spendingGraph(db, parseEntityId("purchase", candidate.id)),
      payments: (
        await getDb(db).execute(
          sql`SELECT * FROM "PurchasePaymentEvidence" WHERE "purchaseId" = ${candidate.id} ORDER BY id`,
        )
      ).rows,
      plan: strong.get(candidate.shortcode) ?? null,
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
      const negative = original.graph.lines.filter(
        (line) => line.cost !== null && line.cost < 0,
      );
      const lines = negative.length
        ? negative
        : original.graph.lines.filter(
            (line) => line.cost !== null && line.cost > 0,
          );
      const categories = new Set(
        lines.map(
          (line) =>
            original.graph.categories.find((entry) => entry.id === line.id)
              ?.category ?? null,
        ),
      );
      const [categoryId] = categories;
      if (categories.size === 1 && categoryId) {
        const inherited = await getDb(db).query.spendingCategory.findFirst({
          where: and(
            eq(
              spendingCategory.id,
              parseEntityId("spendingCategory", categoryId),
            ),
            notDeleted(spendingCategory),
          ),
        });
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
): Promise<FinancialSpendingPlan> {
  const request = spendingRequestBoundary.parse(raw);
  const facts = await spendingFacts(db, request);
  if (facts.allocations.length) {
    const basis = {
      request,
      candidates: [],
      snapshot: await digestValue({
        evidence: canonicalJson(jsonSnapshot.parse(facts)),
      }),
    };
    const existing = await existingSpendingOutcome(db, { facts, basis });
    if (existing) return existing;
  }
  const evidence = await discoverSpendingEvidence(db, request, facts);
  const {
    facts: currentFacts,
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
  } = evidence;
  const { row, source } = currentFacts;
  const review = (reason: string): FinancialSpendingPlan => ({
    ...basis,
    status: "review_required",
    reason,
  });
  if (
    source.status !== "posted" ||
    row?.ledgerTransferId ||
    !["purchase", "refund", "fee"].includes(source.kind)
  )
    return {
      ...basis,
      status: "deferred",
      reason: "Only posted purchase, fee and refund evidence books spending.",
    };
  const violation = financialTransactionSettlementViolation({
    linked: true,
    kind: source.kind,
    amount: source.amount,
  });
  if (violation || source.amount === 0)
    return review(violation?.message ?? "Spending must have a nonzero amount.");
  const existing = await existingSpendingOutcome(db, evidence);
  if (existing) return existing;
  if (request.vendorId && vendor?.shortcode !== request.vendorId)
    return review("The reviewed Vendor is no longer live.");
  const blocker = spendingBlocker({
    facts: currentFacts,
    advice,
    category,
    history,
    vendorResolved: Boolean(vendor),
    ambiguous: ambiguous && !request.vendorId,
    categoryHistoryReviewed:
      request.categoryHistoryReviewed || categoryFromPurchase,
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
  const { row, source, account } = facts;
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
              spendingCategoryId: category?.shortcode,
            }),
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
    purchaserId: account.ledgerParty!.shortcode,
    vendorId: vendor?.shortcode ?? null,
    vendorName: vendor?.name ?? advice!.vendorName,
    spendingCategoryId: category!.shortcode,
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
            facts.account.ledgerParty?.shortcode !== plan.purchaserId ||
            !acceptedVendor ||
            facts.graphs.some(
              (graph) =>
                !graph.target || graph.target.vendorId !== acceptedVendor.id,
            ) ||
            (plan.purchaseId && !fresh.purchaseIds.includes(plan.purchaseId))
          )
            return refuse(
              "The accepted spending identity changed; review its account owner and Purchase Vendor.",
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
