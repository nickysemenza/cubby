import { describe, expect, it } from "vitest";

import { inspectWorkflow } from "~/server/workflow-runtime/definition";

import {
  attachPurchaseProductsWorkflow,
  detachPurchaseProductsWorkflow,
  linkExpensesToPurchaseWorkflow,
  mergePurchasesWorkflow,
  purchaseProductsWorkflow,
  splitExpenseWorkflow,
} from "./purchase.server";

describe("purchase workflow definitions", () => {
  it("exposes the purchase products graph", () => {
    expect(purchaseProductsWorkflow.definition.name).toBe("purchase.products");
    expect(purchaseProductsWorkflow.definition.steps).toHaveLength(2);
    expect(mergePurchasesWorkflow.definition.name).toBe("purchase.merge");
    expect(mergePurchasesWorkflow.definition.steps).toHaveLength(3);
    expect(linkExpensesToPurchaseWorkflow.definition.name).toBe(
      "purchase.link",
    );
    expect(splitExpenseWorkflow.definition.name).toBe("purchase.split");
    expect(attachPurchaseProductsWorkflow.definition.name).toBe(
      "purchase.attachProducts",
    );
    expect(detachPurchaseProductsWorkflow.definition.name).toBe(
      "purchase.detachProducts",
    );
    expect(
      inspectWorkflow(linkExpensesToPurchaseWorkflow.definition).steps.map(
        ({ name, type }) => ({ name, type }),
      ),
    ).toEqual([
      { name: "link", type: "committedCall" },
      { name: "expenseIds", type: "committedEffect" },
      { name: "effects", type: "committedEffect" },
    ]);
    expect(
      inspectWorkflow(splitExpenseWorkflow.definition).steps.map(
        ({ name, type }) => ({ name, type }),
      ),
    ).toEqual([
      { name: "split", type: "committedCall" },
      { name: "references", type: "committedEffect" },
      { name: "effects", type: "committedEffect" },
      { name: "pricing", type: "committedEffect" },
    ]);
    expect(
      inspectWorkflow(mergePurchasesWorkflow.definition).steps.map(
        ({ name, type }) => ({ name, type }),
      ),
    ).toEqual([
      { name: "merge", type: "committedCall" },
      { name: "entityId", type: "committedEffect" },
      { name: "effects", type: "committedEffect" },
    ]);
  });
});
