import { describe, expect, it } from "vitest";

import { inspectWorkflow } from "~/server/workflow-runtime/definition";

import {
  householdContributionLedgerWorkflow,
  projectContributionWorkflow,
  suggestFinancialTransferPairsWorkflow,
} from "./household-contribution.server";

describe("household contribution workflow graphs", () => {
  it("exposes registered definitions for each delegate", () => {
    expect(
      inspectWorkflow(householdContributionLedgerWorkflow.definition).name,
    ).toBe("householdContribution.ledger");
    expect(inspectWorkflow(projectContributionWorkflow.definition).name).toBe(
      "householdContribution.project",
    );
    expect(
      inspectWorkflow(suggestFinancialTransferPairsWorkflow.definition).name,
    ).toBe("householdContribution.suggestFinancialTransferPairs");
  });
});
