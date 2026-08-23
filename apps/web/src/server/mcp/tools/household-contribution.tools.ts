import {
  applyHouseholdLedgerChangesInput,
  applyHouseholdLedgerChangesOut,
  financialTransferPairSuggestionsOut,
  householdContributionLedgerInput,
  householdContributionLedgerOut,
  householdLedgerChangePreviewOut,
  previewHouseholdLedgerChangesInput,
  projectContributionInput,
  projectContributionOut,
  suggestFinancialTransferPairsInput,
} from "@cubby/schemas/household-contribution";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getCaller,
  READ_ONLY_CLOSED,
  registerMcpTool,
  WRITE_CLOSED,
} from "./_shared";

/**
 * Household ledger MCP surface.
 *
 * These tools deliberately accept only reviewed, normalized Cubby changes.
 * Gmail, Splitwise, and Monarch acquisition/parsing stay with the MCP client;
 * the server records domain facts and their source references, never provider
 * credentials, raw mail, or CSV payloads.
 */
export function registerHouseholdContributionTools(server: McpServer) {
  registerMcpTool(server, {
    name: "preview_household_ledger_changes",
    description:
      "Preview normalized household attribution and contribution changes before applying them. Read-only: it creates no Expense attribution, account mapping, funding fund, transfer, or evidence link. Send only reviewed Cubby changes — never raw Gmail messages, Splitwise exports, Monarch CSVs, file paths, credentials, or provider sync settings. The result has a previewFingerprint plus one ready/already_recorded/needs_decision/conflict result per requested change. A preview is advisory: apply_household_ledger_changes re-plans under its transaction and can refuse if evidence or references changed.",
    inputSchema: previewHouseholdLedgerChangesInput,
    outputSchema: householdLedgerChangePreviewOut,
    annotations: READ_ONLY_CLOSED,
    handler: (params, extra) =>
      getCaller(extra).householdContribution.previewChanges(params),
  });

  registerMcpTool(server, {
    name: "apply_household_ledger_changes",
    description:
      "Atomically apply a reviewed household-ledger change set. First call preview_household_ledger_changes, then pass its exact previewFingerprint, the same normalized changes, and a stable idempotencyKey for safe retries. A completed retry returns already_applied; reusing a key for different changes, stale previews, ambiguous source evidence, unresolved people/funds/accounts, or conflicting transfer evidence returns the structured refused branch and writes nothing. This tool records logical transfers once; FinancialTransaction evidence legs are attached as evidence and never become Expenses or project settlement allocations.",
    inputSchema: applyHouseholdLedgerChangesInput,
    outputSchema: applyHouseholdLedgerChangesOut,
    annotations: WRITE_CLOSED,
    handler: (params, extra) =>
      getCaller(extra).householdContribution.applyChanges(params),
  });

  registerMcpTool(server, {
    name: "suggest_financial_transfer_pairs",
    description:
      "Suggest possible two-sided FinancialTransaction evidence for household transfers. It considers only posted, unallocated, not-already-paired transactions with equal-and-opposite amounts on different accounts inside the requested date window. Suggestions are never proof and this tool never writes: inspect candidate reasons and explicitly include selected evidence sides in a reviewed put_funding_transfer change. No project allocation or Expense is created.",
    inputSchema: suggestFinancialTransferPairsInput,
    outputSchema: financialTransferPairSuggestionsOut,
    annotations: READ_ONLY_CLOSED,
    handler: (params, extra) =>
      getCaller(extra).householdContribution.suggestTransferPairs(params),
  });

  registerMcpTool(server, {
    name: "get_household_contribution_ledger",
    description:
      "Read the household-wide contribution ledger as of an optional date. Returns each party's consumption, initial outlay, transfers sent and received, net contribution, and position, plus accounting checks and explicit attribution/evidence gaps. Transfers are household-global: this report never invents a project split for a later repayment.",
    inputSchema: householdContributionLedgerInput,
    outputSchema: householdContributionLedgerOut,
    annotations: READ_ONLY_CLOSED,
    handler: (params, extra) =>
      getCaller(extra).householdContribution.ledger(params),
  });

  registerMcpTool(server, {
    name: "get_project_contribution",
    description:
      "Read one project's whole-group cost, household initial exposure, guest funding, beneficiary consumption, original funders, and attribution gaps. Includes live subprojects by default. This is a spend/funding report only: later reimbursements stay in the household ledger and are intentionally not allocated back to projects.",
    inputSchema: projectContributionInput,
    outputSchema: projectContributionOut,
    annotations: READ_ONLY_CLOSED,
    handler: (params, extra) =>
      getCaller(extra).householdContribution.project(params),
  });
}
