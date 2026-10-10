import type { ExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import {
  type ProductShortcode,
  type ProjectShortcode,
  projectShortcode,
  type PurchaseShortcode,
} from "@cubby/schemas/identifiers";
import type { CostType, Trade } from "@cubby/schemas/project";
import {
  MAX_SPLIT_EXPENSE_PARTS,
  type purchaseSplitCheckOut,
  type purchaseSplitCheckInput,
  type purchaseSplitStartOut,
  SPLIT_NEEDS_PURCHASE_REASON,
  type SplitExpenseInput,
  type SplitPartDraft,
} from "@cubby/schemas/purchase";
import type { z } from "zod";

import { formatCurrency } from "~/lib/utils";
import { assertQuantitySignMatchesCost } from "~/server/repo/expense/helpers";
import { cents, dollars, round2 } from "~/server/repo/money";

/**
 * The split form's rules, kept on the server so web and native share one answer and the write
 * path (`splitExpense`) re-checks the same ones. Money is whole cents: `0.1 + 0.2` is not `0.3`,
 * and a split that is a cent off must never read as complete.
 */

/** What a split needs to know about the expense it replaces. */
export interface SplitOriginal {
  name: string;
  cost: number | null;
  costType: CostType;
  trade: Trade | null;
  spendingCategoryId: string | null;
  projectId: ProjectShortcode | null;
  productId: ProductShortcode | null;
  productName: string | null;
  productQuantity: number | null;
  purchaseId: PurchaseShortcode | null;
  /** A lump-sum allocation, not an itemized line: it cannot link a product. */
  unitemized: boolean;
  /** Household attribution rows exist, so a policy must be chosen. */
  hasAttribution: boolean;
  /** An external source row claims it, so it cannot become several. */
  imported: boolean;
}

/** Resolve the category a replacement part will store after its classifier is known. */
export function resolveSplitPartClassification<
  TOriginalCategory extends string | null,
  TPartCategory extends string | null,
>(input: {
  originalSpendingCategoryId: TOriginalCategory;
  lineKind: ExpenseLineKind;
  partSpendingCategoryId?: TPartCategory;
}) {
  const inheritsOriginal =
    input.partSpendingCategoryId === undefined &&
    input.lineKind === "principal";
  return {
    lineKind: input.lineKind,
    inheritsOriginal,
    spendingCategoryId:
      input.partSpendingCategoryId !== undefined
        ? input.partSpendingCategoryId
        : inheritsOriginal
          ? input.originalSpendingCategoryId
          : null,
  };
}

type CheckOut = z.output<typeof purchaseSplitCheckOut>;
type StartOut = z.output<typeof purchaseSplitStartOut>;
type CheckInput = z.output<typeof purchaseSplitCheckInput>;

const DECIMAL = /^-?(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/;
const NUMBER = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/;

const parseDollars = (raw: string): number | null => {
  const text = raw.trim();
  if (text === "") return 0;
  return DECIMAL.test(text) ? Number(text) : null;
};

const SPLIT_CONFIRM =
  "Splitting replaces this expense with its parts, filed under the same purchase. The original expense is deleted — it is not kept alongside them.";

export function startSplitDraft(original: SplitOriginal): StartOut {
  const blank = (): SplitPartDraft => ({
    name: "",
    cost: "",
    costType: original.costType,
    trade: original.trade,
    projectId: original.projectId ?? "",
    keepProduct: false,
    productQuantity: "",
  });
  return {
    title: `Split "${original.name}"`,
    description:
      "The parts below are filed under the same Purchase and this Expense is deleted — a split replaces the row, it doesn't add to it. Each part carries its own trade and cost type, which is what makes a combo kit's saw half tools and its blade half materials.",
    confirm: SPLIT_CONFIRM,
    originalCost: original.cost,
    productName: original.productName,
    // An unitemized allocation cannot link a product, so none is offered.
    productNote:
      original.productId && !original.unitemized
        ? `"Product" hands ${original.productName ?? "the linked product"} to one part; the rest start with no product.`
        : null,
    maxParts: MAX_SPLIT_EXPENSE_PARTS,
    parts: [
      {
        ...blank(),
        name: original.name,
        // The whole cost on part 1 so the starting form already reconciles; moving money to
        // part 2 is the person's edit, not a guess at the split.
        cost: original.cost === null ? "" : String(original.cost),
        productQuantity:
          original.productQuantity === null
            ? ""
            : String(original.productQuantity),
      },
      blank(),
    ],
  };
}

const note = (partsCents: number, original: number | null) => {
  if (original === null)
    return "The original has no cost recorded, so there's nothing to reconcile against.";
  const delta = partsCents - cents(original);
  if (delta === 0) return "Parts add up to the original cost.";
  return `Parts are ${formatCurrency(Math.abs(dollars(delta)))} ${delta > 0 ? "over" : "under"} the original — a split must add up to it exactly.`;
};

export function checkSplitDraft(
  original: SplitOriginal,
  input: CheckInput,
): CheckOut {
  const { parts, attributionPolicy } = input;
  let reason: string | null = null;
  const refuse = (message: string) => {
    reason ??= message;
  };
  const label = (index: number) => `Part ${index + 1}`;

  const costs = parts.map((part) => parseDollars(part.cost));
  const partsCents = costs.reduce<number>(
    (sum, cost) => sum + (cost === null ? 0 : cents(cost)),
    0,
  );
  const delta =
    original.cost === null ? null : partsCents - cents(original.cost);

  if (!original.purchaseId) refuse(SPLIT_NEEDS_PURCHASE_REASON);
  if (original.imported)
    refuse(
      "Imported Expenses cannot be split because one external source row cannot identify multiple replacement Expenses.",
    );
  if (parts.length < 2) refuse("A split needs at least 2 parts.");
  if (parts.length > MAX_SPLIT_EXPENSE_PARTS)
    refuse(`A split can contain at most ${MAX_SPLIT_EXPENSE_PARTS} parts.`);

  const keeping = parts.filter((part) => part.keepProduct).length;
  if (keeping > 1) refuse("Only one part can keep the product.");

  const body: SplitExpenseInput["parts"] = [];
  parts.forEach((part, index) => {
    const name = part.name.trim();
    if (name === "") return refuse(`${label(index)} needs a name.`);
    if (original.cost === null && part.cost.trim() === "")
      return refuse(
        `${label(index)}: enter a cost — the original has no cost recorded, so a blank would invent $0.`,
      );
    const cost = costs[index];
    if (cost === null || cost === undefined)
      return refuse(
        `${label(index)}: cost must be a dollar amount with at most two decimals.`,
      );
    const projectText = part.projectId.trim();
    let project: ProjectShortcode | null = null;
    if (projectText !== "") {
      const parsed = projectShortcode.safeParse(projectText);
      if (!parsed.success)
        return refuse(
          `${label(index)}: project must be a code such as PRJ-4K7M, or blank.`,
        );
      project = parsed.data;
    }
    let quantity: number | null = null;
    if (part.keepProduct) {
      if (!original.productId)
        return refuse(`${label(index)}: the original has no product to keep.`);
      if (original.unitemized)
        return refuse(
          "Unitemized allocations cannot link a Product. Review actual itemization through the receipt replacement workflow.",
        );
      const text = part.productQuantity.trim();
      if (text !== "") {
        if (!NUMBER.test(text))
          return refuse(`${label(index)}: quantity must be a number.`);
        quantity = Number(text);
      }
      try {
        assertQuantitySignMatchesCost(cost, quantity);
      } catch (error) {
        return refuse(
          `${label(index)}: ${error instanceof Error ? error.message : "quantity does not match the cost."}`,
        );
      }
    }
    body.push({
      name,
      cost: round2(cost),
      costType: part.costType,
      trade: part.trade,
      projectId: project,
      productId: part.keepProduct ? original.productId : null,
      productQuantity: quantity,
    });
  });

  if (reason === null && delta !== null && delta !== 0)
    refuse(
      "Split parts must add up to the original cost exactly — nothing is auto-balanced.",
    );
  if (reason === null && original.hasAttribution && !attributionPolicy)
    refuse(
      "Choose whether the parts inherit or clear the original household attribution.",
    );

  const total = dollars(partsCents);
  let split: SplitExpenseInput | null = null;
  if (reason === null) {
    split = { expenseId: input.expenseId, parts: body };
    // A policy is meaningful only when there is attribution to inherit or clear.
    if (original.hasAttribution && attributionPolicy)
      split.attributionPolicy = attributionPolicy;
  }
  return {
    split,
    partsTotal: total,
    originalCost: original.cost,
    delta: delta === null ? null : dollars(delta),
    reason,
    note: note(partsCents, original.cost),
    needsAttributionPolicy: original.hasAttribution,
  };
}
