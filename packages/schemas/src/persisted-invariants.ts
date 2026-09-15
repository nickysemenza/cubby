import { z } from "zod";

import { locationType } from "./location-fields";
import { mealFoodAmount } from "./meal-amount";
import { mealFoodNutrients } from "./meal-nutrition";
import { wholeCentAmount } from "./money";
import {
  statementDateKind,
  statementRowDispositionReason,
  statementRowProviderStatus,
} from "./statement-row";

const positiveFinite = z.number().finite().positive();
const nonZeroWholeCent = wholeCentAmount.refine((value) => value !== 0, {
  message: "must be non-zero",
});
const positiveWholeCent = wholeCentAmount.positive();
const nullablePositiveInteger = z.number().int().positive().nullable();

const addIssue = (
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void => context.addIssue({ code: "custom", path, message });

export const mealRecipePersistedInvariant = z.object({
  estimatedYieldGrams: nullablePositiveInteger,
  actualYieldGrams: nullablePositiveInteger,
});

export const mealRecipePortionPersistedInvariant = z
  .object({
    amount: mealFoodAmount.nullable(),
    grams: z.number().int().positive().nullable(),
  })
  .superRefine((row, context) => {
    if ((row.amount === null) === (row.grams === null)) {
      addIssue(
        context,
        ["amount"],
        "exactly one of amount or legacy grams is required",
      );
    }
  });

const mealFoodEntryBase = {
  amount: mealFoodAmount.nullable(),
  grams: positiveFinite.nullable(),
};

export const mealFoodEntryPersistedInvariant = z.discriminatedUnion(
  "sourceKind",
  [
    z
      .object({
        ...mealFoodEntryBase,
        sourceKind: z.literal("ingredient"),
        ingredientId: z.string(),
        productId: z.null(),
        name: z.null(),
        nutrients: z.null(),
      })
      .refine((row) => (row.amount === null) !== (row.grams === null), {
        path: ["amount"],
        message: "exactly one of amount or legacy grams is required",
      }),
    z
      .object({
        ...mealFoodEntryBase,
        sourceKind: z.literal("product"),
        ingredientId: z.null(),
        productId: z.string(),
        name: z.null(),
        nutrients: z.null(),
      })
      .refine((row) => (row.amount === null) !== (row.grams === null), {
        path: ["amount"],
        message: "exactly one of amount or legacy grams is required",
      }),
    z
      .object({
        ...mealFoodEntryBase,
        sourceKind: z.literal("manual"),
        ingredientId: z.null(),
        productId: z.null(),
        name: z.string().trim().min(1),
        nutrients: mealFoodNutrients,
      })
      .refine((row) => row.amount === null || row.grams === null, {
        path: ["amount"],
        message: "amount and legacy grams cannot both be present",
      }),
  ],
);

export const locationPersistedInvariant = z
  .object({ type: locationType.nullable(), productId: z.string().nullable() })
  .superRefine((row, context) => {
    if (row.type !== null && row.productId !== null) {
      addIssue(
        context,
        ["productId"],
        "a location may identify either a type or a product, not both",
      );
    }
  });

export const imagePersistedInvariant = z.object({
  perceptualHash: z
    .string()
    .regex(/^[0-9a-f]{16}$/, "must be a lowercase 16-digit hexadecimal hash")
    .nullable(),
});

export const plantingLocationPeriodPersistedInvariant = z.object({
  startKind: z.enum(["actual", "recorded"]),
});

export const dependencyPersistedInvariant = z
  .object({ sourceId: z.string(), blockedById: z.string() })
  .refine((row) => row.sourceId !== row.blockedById, {
    path: ["blockedById"],
    message: "a record cannot depend on itself",
  });

export const ledgerPartyPersistedInvariant = z.object({
  kind: z.enum(["household", "member", "guest"]),
});

export const purchasePersistedInvariant = z.object({
  statedTotal: wholeCentAmount.nullable(),
});

export const productComponentPersistedInvariant = z
  .object({
    parentProductId: z.string(),
    componentProductId: z.string(),
    quantity: z.number().int().positive(),
  })
  .refine((row) => row.parentProductId !== row.componentProductId, {
    path: ["componentProductId"],
    message: "a product cannot be its own component",
  });

export const financialTransactionPersistedInvariant = z
  .object({
    amount: nonZeroWholeCent,
    status: z.string(),
    postedDate: z.string().nullable(),
  })
  .superRefine((row, context) => {
    if (row.status === "posted" && row.postedDate === null) {
      addIssue(context, ["postedDate"], "posted transactions require a date");
    }
  });

export const financialTransactionAllocationPersistedInvariant = z.object({
  amount: nonZeroWholeCent,
});

export const ledgerTransferPersistedInvariant = z.object({
  amount: positiveWholeCent,
});

export const statementImportPersistedInvariant = z.object({
  dateKind: statementDateKind,
  rowCountDeclared: z.number().int().nonnegative().nullable(),
});

export const statementRowPersistedInvariant = z
  .object({
    amount: nonZeroWholeCent,
    providerAmount: nonZeroWholeCent,
    providerStatus: statementRowProviderStatus.nullable(),
    disposition: z.enum(["open", "ignored"]),
    dispositionReason: statementRowDispositionReason.nullable(),
    dispositionNote: z.string().nullable(),
  })
  .superRefine((row, context) => {
    if (
      row.disposition === "open" &&
      (row.dispositionReason !== null || row.dispositionNote !== null)
    ) {
      addIssue(
        context,
        ["disposition"],
        "open rows cannot carry disposition details",
      );
    }
    if (
      row.disposition === "ignored" &&
      (row.dispositionReason === null || row.dispositionNote === null)
    ) {
      addIssue(
        context,
        ["disposition"],
        "ignored rows require a reason and note",
      );
    }
  });

export const expensePersistedInvariant = z
  .object({
    cost: wholeCentAmount.nullable(),
    productId: z.string().nullable(),
    productQuantity: z.number().finite().nullable(),
    lineKind: z.string(),
  })
  .superRefine((row, context) => {
    if (
      row.productQuantity !== null &&
      (row.productId === null ||
        (row.productQuantity === 0 && !(row.cost !== null && row.cost < 0)))
    ) {
      addIssue(
        context,
        ["productQuantity"],
        "quantity requires a product and zero is only valid on a negative-cost line",
      );
    }
    if (row.lineKind !== "principal" && row.productId !== null) {
      addIssue(
        context,
        ["productId"],
        "only principal expense lines may reference a product",
      );
    }
  });

export const expenseAttributionPersistedInvariant = z.object({
  role: z.enum(["beneficiary", "funder"]),
  weight: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const ledgerSourceClaimPersistedInvariant = z
  .object({
    expenseId: z.string().nullable(),
    ledgerTransferId: z.string().nullable(),
    sourceKeyVersion: z.number().int().positive(),
    normalizedEvidence: z.object({ amount: wholeCentAmount }),
    targetAmountAtClaim: wholeCentAmount,
    reconciliationDecision: z.enum(["amounts_match", "accept_target_amount"]),
    reconciliationNote: z.string().nullable(),
  })
  .superRefine((row, context) => {
    if ((row.expenseId === null) === (row.ledgerTransferId === null)) {
      addIssue(context, ["expenseId"], "exactly one claim owner is required");
    }
    const amountsMatch =
      Math.abs(row.normalizedEvidence.amount - row.targetAmountAtClaim) < 1e-7;
    if (
      row.reconciliationDecision === "amounts_match" &&
      (!amountsMatch || row.reconciliationNote !== null)
    ) {
      addIssue(
        context,
        ["reconciliationDecision"],
        "amounts_match requires equal amounts and no note",
      );
    }
    if (
      row.reconciliationDecision === "accept_target_amount" &&
      (amountsMatch || !row.reconciliationNote?.trim())
    ) {
      addIssue(
        context,
        ["reconciliationDecision"],
        "accept_target_amount requires different amounts and an explanation",
      );
    }
  });

export type MealFoodEntryPersistedInvariant = z.output<
  typeof mealFoodEntryPersistedInvariant
>;
