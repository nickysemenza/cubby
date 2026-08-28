import {
  financialTransferPairSuggestionsOut,
  householdContributionLedgerInput,
  householdContributionLedgerOut,
  projectContributionInput,
  projectContributionOut,
  suggestFinancialTransferPairsInput,
} from "@cubby/schemas/household-contribution";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { READ_ONLY_CLOSED, registerRouterTool } from "./_shared";

/** Standard entity surface only: detailed ledger invariants stay in the repos. */
export function registerLedgerTools(server: McpServer) {
  registerRouterTool(server, {
    name: "get_household_contribution_ledger",
    description:
      "Read the household-wide contribution ledger as of a date (today when omitted). Positions include Expenses and Ledger Transfers dated through that day; evidence-gap counts describe currently attached Financial Transaction evidence. This is read-only and never records attribution, transfers, or evidence.",
    inputSchema: householdContributionLedgerInput.shape,
    outputSchema: householdContributionLedgerOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.householdContribution.ledger(params),
  });
  registerRouterTool(server, {
    name: "get_project_contribution",
    description:
      "Read whole-group cost, initial funding, consumption, and attribution gaps for one Project, optionally including descendants. Project reports include planned future Expenses and exclude later household-wide transfers. This is read-only.",
    inputSchema: projectContributionInput.shape,
    outputSchema: projectContributionOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.householdContribution.project(params),
  });
  registerRouterTool(server, {
    name: "suggest_financial_transfer_pairs",
    description:
      "Produce a read-only candidate worklist pairing selected Financial Transaction evidence with opposite-signed, different-account matches. Suggestions never create Ledger Transfers, attach evidence, or make a matching decision; review each candidate before using standard mutations.",
    inputSchema: suggestFinancialTransferPairsInput.shape,
    outputSchema: financialTransferPairSuggestionsOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) =>
      caller.householdContribution.suggestTransferPairs(params),
  });
}
