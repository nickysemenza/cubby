import { describe, expect, it } from "vitest";

import { dashboardContract } from "~/contracts/dashboard.contract";
import { declaredReadPolicy, type OperationContract } from "~/contracts/define";
import { entityDetailContract } from "~/contracts/entity-detail.contract";
import { entityReportContract } from "~/contracts/entity-report.contract";
import { expenseContract } from "~/contracts/expense.contract";
import { financialTransactionContract } from "~/contracts/finance.contract";
import { inventoryContract } from "~/contracts/inventory.contract";
import { locationContract } from "~/contracts/location.contract";
import { mealContract } from "~/contracts/meal.contract";
import { purchaseContract } from "~/contracts/purchase.contract";
import { suggestionsContract } from "~/contracts/suggestions.contract";

import { inputReadPolicy } from "./read-policy";

const policy = (contract: OperationContract, member: string) =>
  declaredReadPolicy(contract, contract.ops[member]!);

describe("shared read policy", () => {
  it("allows bounded-stale reads for display workflows and Home summaries", () => {
    for (const [contract, member] of [
      [dashboardContract, "counts"],
      [suggestionsContract, "list"],
      [expenseContract, "monthlySummary"],
      [locationContract, "valuationSummary"],
      [mealContract, "getNutrition"],
    ] as const)
      expect(policy(contract, member)).toBeUndefined();
  });

  it("keeps money entry, settlement and receiving authoritative", () => {
    for (const [contract, member] of [
      [financialTransactionContract, "previewBooking"],
      [purchaseContract, "settlementCandidates"],
      [purchaseContract, "checkSplit"],
      [expenseContract, "chargeContext"],
      [inventoryContract, "receivingContext"],
    ] as const)
      expect(policy(contract, member)).toBe("strong");
  });

  it("keeps generic reads of financial entities and reports authoritative", () => {
    expect(policy(entityDetailContract, "detail")).toBe("financialEntity");
    expect(policy(entityReportContract, "get")).toBe("financialEntity");
    for (const entity of ["expense", "purchase", "transactionImport"])
      expect(inputReadPolicy(entity, [])).toBe("strong");
    expect(inputReadPolicy("product", [])).toBe("context");
    expect(inputReadPolicy(undefined, ["purchase.reconciliation"])).toBe(
      "strong",
    );
    expect(
      inputReadPolicy(undefined, [
        "product.pricing",
        "purchase.financial-settlement",
      ]),
    ).toBe("strong");
    expect(inputReadPolicy(undefined, ["product.pricing"])).toBe("context");
  });
});
