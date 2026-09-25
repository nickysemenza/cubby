import {
  financialTransferPairSuggestionsOut,
  suggestFinancialTransferPairsInput,
} from "@cubby/schemas/household-contribution";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { suggestFinancialTransferPairs } from "~/server/repo/financial-transfer-pairing";

import { READ_ONLY_CLOSED, registerRouterTool } from "./_shared";

/** Standard entity surface only: detailed ledger invariants stay in the repos. */
export function registerLedgerTools(server: McpServer) {
  registerRouterTool(server, {
    name: "suggest_financial_transfer_pairs",
    description:
      "Produce a read-only candidate worklist pairing selected Financial Transaction evidence with opposite-signed, different-account matches. Suggestions never create Ledger Transfers, attach evidence, or make a matching decision; review each candidate before using standard mutations.",
    inputSchema: suggestFinancialTransferPairsInput,
    outputSchema: financialTransferPairSuggestionsOut,
    annotations: READ_ONLY_CLOSED,
    call: (context, params) =>
      suggestFinancialTransferPairs(context.readDb, params),
  });
}
