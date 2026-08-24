import {
  financialTransferPairSuggestionsOut,
  householdContributionLedgerInput,
  householdContributionLedgerOut,
  projectContributionInput,
  projectContributionOut,
  suggestFinancialTransferPairsInput,
} from "@cubby/schemas/household-contribution";
import {
  ledgerPartyCreateInput,
  ledgerPartyFiltersSchema,
  ledgerPartyListResponse,
  ledgerPartyOut,
  ledgerPartyUpdateData,
} from "@cubby/schemas/ledger-party";
import {
  ledgerTransferCreateInput,
  ledgerTransferFiltersSchema,
  ledgerTransferListResponse,
  ledgerTransferOut,
  ledgerTransferUpdateData,
} from "@cubby/schemas/ledger-transfer";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  defineSlim,
  READ_ONLY_CLOSED,
  registerEntityCrudToolset,
  registerRouterTool,
} from "./_shared";

const slimLedgerParty = defineSlim(ledgerPartyOut, (row) => row as never);
const slimLedgerTransfer = defineSlim(ledgerTransferOut, (row) => row as never);

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
  registerEntityCrudToolset(server, {
    entity: "ledgerParty",
    entityPlural: "ledger_parties",
    names: { get: "get_ledger_party" },
    createInput: ledgerPartyCreateInput.shape,
    updateShape: ledgerPartyUpdateData.shape,
    filterFields: ledgerPartyFiltersSchema.shape,
    mcpListOut: ledgerPartyListResponse,
    out: ledgerPartyOut,
    slim: slimLedgerParty,
    sort: { orderBy: "name", direction: "asc" },
    get: (caller, id) => caller.ledgerParty.getByID({ id }),
    create: (caller, params) => caller.ledgerParty.create(params),
    descriptions: {
      list: "List ledger parties. LPY- parties are household members, guests, or the protected household singleton.",
      get: "Get a ledger party by LPY- shortcode.",
      create: "Create a ledger party. There can be only one household party.",
      update:
        "Update a ledger party. The household singleton cannot change kind.",
      delete:
        "Delete a ledger party only when it has no live attributions, accounts, or transfers.",
    },
  });
  registerEntityCrudToolset(server, {
    entity: "ledgerTransfer",
    entityPlural: "ledger_transfers",
    names: { get: "get_ledger_transfer" },
    createInput: ledgerTransferCreateInput.shape,
    updateShape: ledgerTransferUpdateData.shape,
    filterFields: ledgerTransferFiltersSchema.shape,
    mcpListOut: ledgerTransferListResponse,
    out: ledgerTransferOut,
    slim: slimLedgerTransfer,
    sort: { orderBy: "date", direction: "desc" },
    get: (caller, id) => caller.ledgerTransfer.getByID({ id }),
    create: (caller, params) => caller.ledgerTransfer.create(params),
    descriptions: {
      list: "List ledger transfers. LTR- transfers record household contribution, distribution, reimbursement, and internal movement.",
      get: "Get a ledger transfer by LTR- shortcode.",
      create:
        "Create a ledger transfer with optional normalized source claims and up to two posted evidence transactions.",
      update:
        "Update a transfer. Supplied source claims or evidence replace their complete sets.",
      delete:
        "Delete a transfer. Its evidence transactions remain as ordinary financial records.",
    },
  });
}
