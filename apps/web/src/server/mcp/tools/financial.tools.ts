import {
  financialAccountCreateInput,
  financialAccountFilterFields,
  financialAccountListResponse,
  financialAccountOut,
  financialAccountUpdateData,
} from "@cubby/schemas/financial-account";
import {
  financialStatementImportPreviewInput,
  financialStatementImportPreviewOut,
  financialTransactionCreateInput,
  financialTransactionFilterFields,
  financialTransactionListResponse,
  financialTransactionOut,
  financialTransactionUpdateData,
} from "@cubby/schemas/financial-transaction";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  defineSlim,
  READ_ONLY_CLOSED,
  registerEntityCrudToolset,
  registerRouterTool,
} from "./_shared";

const slimFinancialAccount = defineSlim(
  financialAccountOut,
  (row) => row as never,
);
const slimFinancialTransaction = defineSlim(
  financialTransactionOut,
  (row) => row as never,
);
/** Ordinary CRUD only: reconciliation agents read/merge/write evidence; there
 * is intentionally no importer, provider upsert, or automatic matcher. */
export function registerFinancialTools(server: McpServer) {
  registerEntityCrudToolset(server, {
    entity: "financialAccount",
    entityPlural: "financial_accounts",
    names: {
      get: "get_financial_account",
      create: "create_financial_account",
      update: "update_financial_account",
    },
    createInput: financialAccountCreateInput.shape,
    updateShape: financialAccountUpdateData.shape,
    filterFields: financialAccountFilterFields,
    mcpListOut: financialAccountListResponse,
    out: financialAccountOut,
    slim: slimFinancialAccount,
    sort: { orderBy: "name", direction: "asc" },
    get: (caller, id) => caller.financialAccount.getByID({ id }),
    create: (caller, params) => caller.financialAccount.create(params),
    descriptions: {
      list: "List Financial Accounts. IDs are FAC- shortcodes. Accounts identify statement and receipt sources; they never hold Cubby spend. Filter by search, identity kind, provisional status, last four, source, or external account ID.",
      get: "Get a Financial Account by FAC- shortcode. Identity and sourceAliases are complete replacement values on update: read, merge locally, then write the full array/object.",
      create:
        "Create a Financial Account, including provisional accounts such as Visa ····3692. Source aliases are evidence, not finance-provider synchronization.",
      update:
        "Update a Financial Account. `identity` and `sourceAliases` replace their complete values; read–merge–write to preserve existing evidence.",
      delete:
        "Soft-delete Financial Accounts. Deletion is refused while live Financial Transactions reference the account.",
    },
  });
  registerEntityCrudToolset(server, {
    entity: "financialTransaction",
    entityPlural: "financial_transactions",
    names: {
      get: "get_financial_transaction",
      create: "create_financial_transaction",
      update: "update_financial_transaction",
    },
    createInput: financialTransactionCreateInput.shape,
    updateShape: financialTransactionUpdateData.shape,
    filterFields: financialTransactionFilterFields,
    mcpListOut: financialTransactionListResponse,
    out: financialTransactionOut,
    slim: slimFinancialTransaction,
    sort: { orderBy: "postedDate", direction: "desc" },
    get: (caller, id) => caller.financialTransaction.getByID({ id }),
    create: (caller, params) => caller.financialTransaction.create(params),
    descriptions: {
      list: "List Financial Transactions. IDs are FTX- shortcodes. Filter by account, Purchase or presence, kind, status, source/reference, merchant/search, amount, and transaction or posted dates. Amounts are settlement evidence and never enter spend.",
      get: "Get one Financial Transaction by FTX- shortcode.",
      create:
        "Create settlement evidence. Positive amounts are charges/outflows; negative amounts are refunds/inflows. Allocate it across the Purchases it settled via `allocations` ([{purchaseId, amount}]), which must sum to `amount` and share its sign — one real card line can settle several orders. `purchaseId` is shorthand for a single allocation of the full amount; supplying both is rejected unless they agree. Omit both to leave it unmatched. Posted entries require postedDate. Preserve statement/provider evidence in sourceRefs when available: a posted transaction with no sourceRefs may leave its Purchase's settlement_reference data-quality check unresolved unless the linked account itself supplies qualifying cash evidence.",
      update:
        "Update a Financial Transaction, for example when a pending refund posts. `sourceRefs` replaces the complete array; read–merge–write when appending statement evidence. Posting without sourceRefs may leave the linked Purchase's settlement_reference gap unresolved unless the account supplies qualifying cash evidence.",
      delete:
        "Soft-delete Financial Transactions. Deleted and void transactions do not participate in Purchase reconciliation.",
    },
  });

  registerRouterTool(server, {
    name: "preview_financial_statement_import",
    description:
      "Preview client-parsed Monarch statement rows before recording settlement evidence. Cubby accepts normalized rows only — never a CSV path, upload, or file contents. Pass at most 200 rows. Monarch charges are negative in the export and are normalized to positive Cubby outflows; credits become negative. The preview derives a stable source reference from account/date/amount/original statement, resolves an existing Financial Account only when unambiguous, and returns already_recorded, ready_to_create, possible_existing, unresolved_account, or indistinguishable_duplicate for each row. Unresolved rows include a non-persisted provisional Account suggestion. This tool is read-only: it never creates Accounts, Financial Transactions, Purchases, or links. Create only user-approved ready_to_create rows afterwards with create_financial_transactions using the returned proposed fields and accountId, then review every per-item result.",
    inputSchema: financialStatementImportPreviewInput.shape,
    outputSchema: financialStatementImportPreviewOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) =>
      caller.financialTransaction.previewStatementImport(params),
  });
}
