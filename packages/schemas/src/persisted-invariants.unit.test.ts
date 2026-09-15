import { describe, expect, it } from "vitest";

import {
  dependencyPersistedInvariant,
  expenseAttributionPersistedInvariant,
  expensePersistedInvariant,
  financialTransactionAllocationPersistedInvariant,
  financialTransactionPersistedInvariant,
  imagePersistedInvariant,
  ledgerPartyPersistedInvariant,
  ledgerSourceClaimPersistedInvariant,
  ledgerTransferPersistedInvariant,
  locationPersistedInvariant,
  mealFoodEntryPersistedInvariant,
  mealRecipePersistedInvariant,
  mealRecipePortionPersistedInvariant,
  plantingLocationPeriodPersistedInvariant,
  productComponentPersistedInvariant,
  purchasePersistedInvariant,
  statementImportPersistedInvariant,
  statementRowPersistedInvariant,
} from "./persisted-invariants";

const amount = { value: 30, unit: "g" };

describe("application-owned persisted invariants", () => {
  it.each([
    [
      "meal estimated yield",
      mealRecipePersistedInvariant,
      { estimatedYieldGrams: 0, actualYieldGrams: null },
    ],
    [
      "meal actual yield",
      mealRecipePersistedInvariant,
      { estimatedYieldGrams: null, actualYieldGrams: -1 },
    ],
    [
      "portion legacy grams",
      mealRecipePortionPersistedInvariant,
      { amount: null, grams: 0 },
    ],
    [
      "portion amount source",
      mealRecipePortionPersistedInvariant,
      { amount: null, grams: null },
    ],
    [
      "meal ingredient source",
      mealFoodEntryPersistedInvariant,
      {
        sourceKind: "ingredient",
        ingredientId: null,
        productId: "product",
        amount,
        grams: null,
        name: null,
        nutrients: null,
      },
    ],
    [
      "meal product amount compatibility",
      mealFoodEntryPersistedInvariant,
      {
        sourceKind: "product",
        ingredientId: null,
        productId: "product",
        amount,
        grams: 30,
        name: null,
        nutrients: null,
      },
    ],
    [
      "meal manual source",
      mealFoodEntryPersistedInvariant,
      {
        sourceKind: "manual",
        ingredientId: null,
        productId: null,
        amount: null,
        grams: null,
        name: " ",
        nutrients: {},
      },
    ],
    [
      "location identity",
      locationPersistedInvariant,
      { type: "room", productId: "product" },
    ],
    ["image hash", imagePersistedInvariant, { perceptualHash: "XYZ" }],
    [
      "planting period kind",
      plantingLocationPeriodPersistedInvariant,
      { startKind: "guess" },
    ],
    [
      "self dependency",
      dependencyPersistedInvariant,
      { sourceId: "same", blockedById: "same" },
    ],
    ["ledger party kind", ledgerPartyPersistedInvariant, { kind: "vendor" }],
    ["purchase cents", purchasePersistedInvariant, { statedTotal: 1.001 }],
    [
      "component quantity",
      productComponentPersistedInvariant,
      { parentProductId: "one", componentProductId: "two", quantity: 0 },
    ],
    [
      "self component",
      productComponentPersistedInvariant,
      { parentProductId: "same", componentProductId: "same", quantity: 1 },
    ],
    [
      "transaction cents",
      financialTransactionPersistedInvariant,
      { amount: 1.001, status: "pending", postedDate: null },
    ],
    [
      "posted date",
      financialTransactionPersistedInvariant,
      { amount: 1, status: "posted", postedDate: null },
    ],
    [
      "allocation cents",
      financialTransactionAllocationPersistedInvariant,
      { amount: 0 },
    ],
    ["transfer amount", ledgerTransferPersistedInvariant, { amount: -1 }],
    [
      "statement date kind",
      statementImportPersistedInvariant,
      { dateKind: "settled", rowCountDeclared: null },
    ],
    [
      "statement row count",
      statementImportPersistedInvariant,
      { dateKind: "posted", rowCountDeclared: -1 },
    ],
    [
      "statement amounts",
      statementRowPersistedInvariant,
      {
        amount: 0,
        providerAmount: 1,
        providerStatus: null,
        disposition: "open",
        dispositionReason: null,
        dispositionNote: null,
      },
    ],
    [
      "statement provider status",
      statementRowPersistedInvariant,
      {
        amount: 1,
        providerAmount: 1,
        providerStatus: "cleared",
        disposition: "open",
        dispositionReason: null,
        dispositionNote: null,
      },
    ],
    [
      "open statement disposition",
      statementRowPersistedInvariant,
      {
        amount: 1,
        providerAmount: 1,
        providerStatus: null,
        disposition: "open",
        dispositionReason: "other",
        dispositionNote: "note",
      },
    ],
    [
      "ignored statement disposition",
      statementRowPersistedInvariant,
      {
        amount: 1,
        providerAmount: 1,
        providerStatus: null,
        disposition: "ignored",
        dispositionReason: null,
        dispositionNote: null,
      },
    ],
    [
      "expense cents",
      expensePersistedInvariant,
      {
        cost: 1.001,
        productId: null,
        productQuantity: null,
        lineKind: "principal",
      },
    ],
    [
      "expense quantity owner",
      expensePersistedInvariant,
      { cost: 1, productId: null, productQuantity: 1, lineKind: "principal" },
    ],
    [
      "expense zero quantity",
      expensePersistedInvariant,
      {
        cost: 1,
        productId: "product",
        productQuantity: 0,
        lineKind: "principal",
      },
    ],
    [
      "expense line kind",
      expensePersistedInvariant,
      {
        cost: 1,
        productId: "product",
        productQuantity: 1,
        lineKind: "shipping",
      },
    ],
    [
      "attribution role",
      expenseAttributionPersistedInvariant,
      { role: "owner", weight: 1 },
    ],
    [
      "attribution weight",
      expenseAttributionPersistedInvariant,
      { role: "funder", weight: 0 },
    ],
    [
      "claim owner",
      ledgerSourceClaimPersistedInvariant,
      {
        expenseId: null,
        ledgerTransferId: null,
        sourceKeyVersion: 1,
        normalizedEvidence: { amount: 1 },
        targetAmountAtClaim: 1,
        reconciliationDecision: "amounts_match",
        reconciliationNote: null,
      },
    ],
    [
      "claim version",
      ledgerSourceClaimPersistedInvariant,
      {
        expenseId: "expense",
        ledgerTransferId: null,
        sourceKeyVersion: 0,
        normalizedEvidence: { amount: 1 },
        targetAmountAtClaim: 1,
        reconciliationDecision: "amounts_match",
        reconciliationNote: null,
      },
    ],
    [
      "claim reconciliation",
      ledgerSourceClaimPersistedInvariant,
      {
        expenseId: "expense",
        ledgerTransferId: null,
        sourceKeyVersion: 1,
        normalizedEvidence: { amount: 2 },
        targetAmountAtClaim: 1,
        reconciliationDecision: "amounts_match",
        reconciliationNote: null,
      },
    ],
  ])("rejects %s violations", (_label, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});
