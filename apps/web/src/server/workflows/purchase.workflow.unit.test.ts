import { describe, expect, it } from "vitest";

import { inspectWorkflow } from "~/server/workflow-runtime/definition";

import {
  linkExpensesToPurchaseWorkflow,
  splitExpenseWorkflow,
} from "./purchase.server";

describe("purchase workflow definitions", () => {
  it("runs purchase effects after their committed mutations", () => {
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
  });
});
