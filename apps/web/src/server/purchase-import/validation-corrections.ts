import { type ActorContext, actorInRun } from "@cubby/schemas/context";
import {
  type ProductId,
  type PurchaseId,
  type PurchaseShortcode,
  type RunId,
  shortcodeSchema,
} from "@cubby/schemas/identifiers";
import { expenseCreateInput } from "@cubby/schemas/project";
import {
  applyValidationCorrectionsInput,
  applyValidationCorrectionsOut,
  type ApplyValidationCorrectionsOut,
  type ValidationCorrection,
  type ValidationDiff,
  validationDiff,
  validationPlanLine,
} from "@cubby/schemas/purchase-import";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  expense,
  product,
  purchase,
  runOperation,
  run as runTable,
  runTarget,
} from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/repo/database-helpers";
import {
  createExpense,
  deleteExpensesWithPurchaseEffects,
  updateExpense,
} from "~/server/repo/expense/crud";
import { updatePurchase } from "~/server/repo/purchase";
import { sha256Hex } from "~/server/semantic/hash";

import { loadRunScopeByShortcode } from "./run-service";
import {
  compareValidationPlan,
  type LiveValidationState,
  PURCHASE_CURRENCY,
} from "./validation-corrections-compare";

type Reader = Parameters<typeof getDb>[0];

/**
 * Read a Purchase and its live Expenses in the shape validation compares.
 * With `lock`, the Purchase and its Expense rows are locked `FOR UPDATE` so a
 * concurrent edit cannot slip between the stale check and the writes.
 */
export async function loadLiveValidationState(
  db: Reader,
  purchaseId: PurchaseId,
  options: { lock: boolean; requireLive: boolean },
): Promise<LiveValidationState | null> {
  const database = getDb(db);
  const purchaseQuery = database
    .select({
      shortcode: purchase.shortcode,
      orderId: purchase.orderId,
      statedTotal: purchase.statedTotal,
    })
    .from(purchase)
    .where(
      options.requireLive
        ? and(eq(purchase.id, purchaseId), notDeleted(purchase))
        : eq(purchase.id, purchaseId),
    )
    .limit(1);
  const [row] = options.lock
    ? await purchaseQuery.for("update")
    : await purchaseQuery;
  if (!row) return null;
  const linesQuery = database
    .select({
      code: expense.shortcode,
      title: expense.name,
      amount: expense.cost,
      lineKind: expense.lineKind,
      quantity: expense.productQuantity,
      linkedProductId: expense.productId,
      productCode: product.shortcode,
    })
    .from(expense)
    .leftJoin(
      product,
      and(eq(product.id, expense.productId), notDeleted(product)),
    )
    .where(and(eq(expense.purchaseId, purchaseId), notDeleted(expense)));
  const lines = options.lock
    ? await linesQuery.for("update", { of: expense })
    : await linesQuery;
  return {
    purchaseCode: row.shortcode,
    orderId: row.orderId,
    statedTotal: row.statedTotal,
    lines: lines.flatMap((line) =>
      // A live Expense with no amount is an unpriced shell the evidence plan
      // cannot describe; it is left out rather than coerced to zero.
      line.amount === null
        ? []
        : [
            {
              code: line.code,
              title: line.title,
              amount: line.amount,
              lineKind: line.lineKind,
              quantity: line.quantity,
              productId: line.productCode,
              explicitProduct: line.linkedProductId !== null,
            },
          ],
    ),
  };
}

type StaleEntry = { correctionId: string | null; reason: string };

const stalenessReason = (
  stored: ValidationCorrection,
  fresh: ValidationCorrection,
) =>
  `The live record changed since this diff was reviewed: fingerprint ${stored.fingerprint} (reviewed) is now ${fresh.fingerprint}; before ${JSON.stringify(stored.before)} is now ${JSON.stringify(fresh.before)}.`;

/**
 * Hold each selected id against the reviewed diff and against live state
 * recomputed from the stored plan. Any miss means the selection is stale.
 */
function selectCorrections(
  ids: readonly string[],
  reviewedCorrections: readonly ValidationCorrection[],
  freshCorrections: readonly ValidationCorrection[],
) {
  const stale: StaleEntry[] = [];
  const selected: ValidationCorrection[] = [];
  for (const id of ids) {
    const reviewed = reviewedCorrections.find((c) => c.id === id);
    const current = freshCorrections.find((c) => c.id === id);
    if (!reviewed)
      stale.push({
        correctionId: id,
        reason: "Not a selectable correction in the reviewed diff.",
      });
    else if (!current)
      stale.push({
        correctionId: id,
        reason:
          "The live record no longer needs this correction, or it can no longer be derived from the stored evidence plan.",
      });
    else if (
      current.fingerprint !== reviewed.fingerprint ||
      JSON.stringify(current.before) !== JSON.stringify(reviewed.before)
    )
      stale.push({
        correctionId: id,
        reason: stalenessReason(reviewed, current),
      });
    else selected.push(current);
  }
  return { stale, selected };
}

const finishedRunStatuses = new Set(["needs_review", "completed"]);

/** Field corrections for one Expense collapse into a single update so its invariants see the whole change. */
function expenseUpdateData(corrections: readonly ValidationCorrection[]) {
  const data: Parameters<typeof updateExpense>[2] = {};
  for (const { field, after } of corrections) {
    if (field === "title") data.name = z.string().parse(after);
    else if (field === "amount") data.cost = z.number().parse(after);
    else if (field === "quantity")
      data.productQuantity = z.number().nullable().parse(after);
    else if (field === "lineKind")
      data.lineKind = validationPlanLine.shape.lineKind.parse(after);
    else if (field === "productId")
      data.productId = shortcodeSchema("product").parse(after);
  }
  return data;
}

/** A principal line needs a trade from itself, its Purchase, or its Project; siblings that all agree are the only inference made. */
async function inferAddedTrade(txDb: Database, purchaseId: PurchaseId) {
  const database = getDb(txDb);
  const [row] = await database
    .select({ date: purchase.date, defaultTrade: purchase.defaultTrade })
    .from(purchase)
    .where(eq(purchase.id, purchaseId));
  if (!row) throw new Error("The Purchase disappeared while applying");
  const siblingTrades = new Set(
    (
      await database
        .select({ trade: expense.trade })
        .from(expense)
        .where(and(eq(expense.purchaseId, purchaseId), notDeleted(expense)))
    ).flatMap((sibling) => (sibling.trade ? [sibling.trade] : [])),
  );
  return {
    date: row.date,
    trade:
      row.defaultTrade === null && siblingTrades.size === 1
        ? ([...siblingTrades][0] ?? null)
        : null,
  };
}

/**
 * Write the accepted set through the normal Purchase/Expense paths, under the
 * Run's id so each write is audited with it. Order: stated total, field
 * updates, removals, additions. A throw anywhere rolls the whole transaction
 * back.
 */
async function writeCorrections(
  txDb: Database,
  runActor: ActorContext,
  input: { purchaseCode: PurchaseShortcode; purchaseId: PurchaseId },
  plan: ValidationDiff["expected"],
  selected: readonly ValidationCorrection[],
) {
  const priceAffected = new Set<ProductId>();
  const remember = (ids: readonly ProductId[]) => {
    for (const id of ids) priceAffected.add(id);
  };
  for (const correction of selected) {
    if (correction.kind === "purchase_stated_total")
      await updatePurchase(
        txDb,
        input.purchaseCode,
        { statedTotal: z.number().nullable().parse(correction.after) },
        runActor,
      );
  }
  const fieldsByExpense = new Map<string, ValidationCorrection[]>();
  for (const correction of selected) {
    if (correction.kind === "expense_field")
      fieldsByExpense.set(correction.target.code, [
        ...(fieldsByExpense.get(correction.target.code) ?? []),
        correction,
      ]);
  }
  for (const [code, corrections] of fieldsByExpense) {
    const updated = await updateExpense(
      txDb,
      shortcodeSchema("expense").parse(code),
      expenseUpdateData(corrections),
      runActor,
    );
    remember(updated.priceAffectedProductIds);
  }
  const removals = selected
    .filter((correction) => correction.kind === "expense_remove")
    .map((correction) =>
      shortcodeSchema("expense").parse(correction.target.code),
    );
  if (removals.length > 0)
    remember(
      (await deleteExpensesWithPurchaseEffects(txDb, removals, runActor))
        .priceAffectedProductIds,
    );
  const additions = selected.filter(
    (correction) => correction.kind === "expense_add",
  );
  const added =
    additions.length > 0 ? await inferAddedTrade(txDb, input.purchaseId) : null;
  for (const correction of additions) {
    const line = plan.lines.find(
      (candidate) =>
        JSON.stringify(candidate) === JSON.stringify(correction.after),
    );
    if (!line || !added)
      throw new Error(`Correction ${correction.id} lost its plan line`);
    const created = await createExpense(
      txDb,
      expenseCreateInput.parse({
        purchaseId: input.purchaseCode,
        name: line.title,
        cost: line.amount,
        date: added.date,
        lineKind: line.lineKind,
        lineBasis: "item_line",
        costType: "materials",
        trade: added.trade,
        economicRole: "vendor",
        productId: line.productId,
        productQuantity: line.quantity,
      }),
      runActor,
    );
    remember(created.priceAffectedProductIds);
  }
  return [...priceAffected];
}

/**
 * Re-derive the diff from what is now live so a partial application leaves
 * exactly the unselected remainder reviewable, and mark the target. No new
 * outcome value exists for "corrected": a target that now matches its plan is
 * `replayed` (or `raw_evidence_drift`), one that does not stays `semantic_drift`.
 */
async function recordAppliedOutcome(
  txDb: Database,
  scope: { runId: RunId; status: string },
  target: { id: string },
  purchaseId: PurchaseId,
  stored: ValidationDiff,
  note: string,
) {
  const database = getDb(txDb);
  const after = await loadLiveValidationState(txDb, purchaseId, {
    lock: false,
    requireLive: true,
  });
  if (!after) throw new Error("The Purchase disappeared while applying");
  const rest = await compareValidationPlan(stored.expected, after);
  const outcome = rest.equal
    ? stored.rawEvidenceDrift
      ? "raw_evidence_drift"
      : "replayed"
    : "semantic_drift";
  await database
    .update(runTarget)
    .set({
      state: rest.equal ? "completed" : "unresolved",
      outcome,
      diff: rest.equal
        ? null
        : validationDiff.parse({
            version: 2,
            expected: stored.expected,
            actual: {
              orderId: after.orderId,
              currency: PURCHASE_CURRENCY,
              statedTotal: after.statedTotal,
              lines: after.lines.map(
                ({ code: _code, explicitProduct: _explicit, ...line }) => line,
              ),
            },
            corrections: rest.corrections,
            notes: rest.notes,
            rawEvidenceDrift: stored.rawEvidenceDrift,
          }),
      warning: stored.rawEvidenceDrift
        ? `The source evidence changed, but the resulting Purchase plan is semantically identical. ${note}`
        : note,
      updatedAt: new Date(),
    })
    .where(eq(runTarget.id, target.id));
  if (rest.equal && scope.status === "needs_review") {
    const targets = await database
      .select({ state: runTarget.state })
      .from(runTarget)
      .where(eq(runTarget.runId, scope.runId));
    if (targets.every((row) => row.state !== "unresolved"))
      await database
        .update(runTable)
        .set({ status: "completed", updatedAt: new Date() })
        .where(
          and(
            eq(runTable.id, scope.runId),
            eq(runTable.status, "needs_review"),
          ),
        );
  }
  return { outcome, remaining: rest.corrections.length };
}

type ApplyOutcome = {
  result: ApplyValidationCorrectionsOut;
  priceAffectedProductIds: ProductId[];
};

const noPriceEffects = (
  result: ApplyValidationCorrectionsOut,
): ApplyOutcome => ({
  result,
  priceAffectedProductIds: [],
});

/**
 * A person applies a reviewed subset of a purchase-validation diff.
 *
 * Everything happens in one transaction that locks the target, the Purchase,
 * and its Expenses: the corrections are recomputed from the stored evidence
 * plan against live state, a selection that no longer holds is refused with raw
 * diagnostics (nothing written), and the accepted set goes through the normal
 * Expense/Purchase write paths under the Run's id. Stock and settlement
 * allocations are never touched: allocations sum to transaction amounts, not
 * to the stated total.
 */
export async function applyValidationCorrections(
  db: Database,
  rawInput: z.input<typeof applyValidationCorrectionsInput>,
  actor: ActorContext,
): Promise<ApplyOutcome> {
  const input = applyValidationCorrectionsInput.parse(rawInput);
  const correctionIds = [...new Set(input.correctionIds)].sort();
  const scope = await loadRunScopeByShortcode(db, input.runId);
  if (scope.actorUserId !== actor.userId)
    throw new Error("Purchase import run is not owned by this member");
  if (scope.public.purpose !== "purchase_validation")
    throw new Error("Corrections apply only to a purchase validation run");
  if (!finishedRunStatuses.has(scope.public.status))
    throw new Error(
      `Validation corrections wait for the run to finish; it is ${scope.public.status}.`,
    );
  const runActor = actorInRun(actor, scope.public.runId);
  const fingerprint = await sha256Hex(
    JSON.stringify({ ...input, correctionIds }),
  );
  const refuse = (stale: StaleEntry[]) =>
    noPriceEffects(
      applyValidationCorrectionsOut.parse({
        status: "stale",
        runId: input.runId,
        purchaseId: input.purchaseId,
        stale,
      }),
    );

  return withTransactionDatabase(db, async (txDb) => {
    const database = getDb(txDb);
    const [purchaseRow] = await database
      .select({ id: purchase.id })
      .from(purchase)
      .where(eq(purchase.shortcode, input.purchaseId))
      .limit(1);
    if (!purchaseRow)
      throw new Error(`Purchase not found: ${input.purchaseId}`);
    const [target] = await database
      .select({ id: runTarget.id, diff: runTarget.diff })
      .from(runTarget)
      .where(
        and(
          eq(runTarget.runId, scope.public.runId),
          eq(runTarget.entityId, purchaseRow.id),
        ),
      )
      .limit(1)
      .for("update");
    if (!target)
      throw new Error(`${input.purchaseId} is not a target of this run`);

    const [existing] = await database
      .select({
        inputFingerprint: runOperation.inputFingerprint,
        result: runOperation.result,
      })
      .from(runOperation)
      .where(
        and(
          eq(runOperation.runId, scope.public.runId),
          eq(runOperation.operationId, input.operationId),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.inputFingerprint !== fingerprint)
        throw new Error("Operation id was replayed with different input");
      return noPriceEffects(
        applyValidationCorrectionsOut.parse(existing.result),
      );
    }

    const stored = validationDiff.safeParse(target.diff);
    if (!stored.success)
      throw new Error(
        "This validation target has no reviewable corrections; run validation again.",
      );
    const live = await loadLiveValidationState(txDb, purchaseRow.id, {
      lock: true,
      requireLive: true,
    });
    if (!live)
      return refuse([
        {
          correctionId: null,
          reason: `${input.purchaseId} was deleted after this diff was reviewed.`,
        },
      ]);
    const fresh = await compareValidationPlan(stored.data.expected, live);
    const { stale, selected } = selectCorrections(
      correctionIds,
      stored.data.corrections,
      fresh.corrections,
    );
    if (stale.length > 0) return refuse(stale);

    const priceAffectedProductIds = await writeCorrections(
      txDb,
      runActor,
      { purchaseCode: input.purchaseId, purchaseId: purchaseRow.id },
      stored.data.expected,
      selected,
    );
    const { outcome, remaining } = await recordAppliedOutcome(
      txDb,
      { runId: scope.public.runId, status: scope.public.status },
      target,
      purchaseRow.id,
      stored.data,
      `Applied ${selected.length} reviewed correction${selected.length === 1 ? "" : "s"} (${input.operationId}).`,
    );
    const result = applyValidationCorrectionsOut.parse({
      status: "applied",
      runId: input.runId,
      purchaseId: input.purchaseId,
      operationId: input.operationId,
      applied: selected.map((correction) => correction.id),
      outcome,
      remainingCorrections: remaining,
    });
    await database.insert(runOperation).values({
      runId: scope.public.runId,
      operationId: input.operationId,
      kind: "apply_validation_corrections",
      inputFingerprint: fingerprint,
      state: "completed",
      result,
      completedAt: new Date(),
    });
    return { result, priceAffectedProductIds };
  });
}
