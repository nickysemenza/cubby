import { z } from "zod";

import { importRunId } from "./identifier-fields";
import { importRunPurpose } from "./import-run-fields";

/** Purposes currently coordinated by the durable Flue ImportRun agent. */
export const flueImportRunPurpose = importRunPurpose.extract([
  "account_sync",
  "purchase_validation",
  "product_enrichment",
  "photo_inventory",
]);
export type FlueImportRunPurpose = z.infer<typeof flueImportRunPurpose>;

// These prefixes are persisted in ImportRun.agentSessionId and Flue Durable
// Object storage. Existing conversations must retain their original identity.
const instancePrefix = {
  account_sync: "import-run",
  purchase_validation: "import-run",
  product_enrichment: "import-run",
  photo_inventory: "photo-inventory",
} satisfies Record<FlueImportRunPurpose, string>;
const validPrefixes = new Set<string>(Object.values(instancePrefix));

export function importRunAgentIdentity(
  runId: string,
  purpose: FlueImportRunPurpose,
): string {
  return `${instancePrefix[purpose]}:${importRunId.parse(runId)}`;
}

/** Resolve only agent-owned Flue instances; other observations are ignored. */
export function importRunIdFromAgentIdentity(
  instanceId: string | undefined,
): string | undefined {
  if (!instanceId) return undefined;
  const colon = instanceId.indexOf(":");
  if (colon < 0) return undefined;
  const prefix = instanceId.slice(0, colon);
  if (!validPrefixes.has(prefix)) return undefined;
  return importRunId.safeParse(instanceId.slice(colon + 1)).data;
}

/** The purchase agent's own tools (apps/purchase-agent/src/tools.ts). */
const IMPORT_RUN_AGENT_TOOLS = [
  "claim_next_import_work",
  "extract_receipt_evidence",
  "extract_run_evidence",
  "issue_browser_command",
  "read_browser_command_result",
  "import_browser_order_evidence",
  "report_agent_progress",
  "save_navigation_hints",
  "mark_history_expired",
  "finish_import_run",
  "stop_import_run_for_review",
] as const;
export type ImportRunAgentToolName = (typeof IMPORT_RUN_AGENT_TOOLS)[number];

const PHOTO_MCP_TOOLS = [
  "get_photo_run_context",
  "get_image_processing",
  "suggest_photo_product_candidates",
  "resolve_products",
  "find_similar_entities",
  "propose_photo_groups",
  "list_photo_group_proposals",
  "patch_product_external_ids",
] as const;

// Tools purchase runs called in production plus those the purchase-import and
// product-enrichment skills (mounted on every purchase run) name.
const PURCHASE_MCP_TOOLS = [
  "commit_purchase_import",
  "confirm_purchase_merchant_vendor",
  "entity",
  "entity_batch",
  "find_product_external_id_collisions",
  "find_similar_entities",
  "find_statement_row_drift",
  "get_entities",
  "get_vendor_coverage",
  "global_search",
  "import_operation_status",
  "list_purchase_products",
  "list_statement_imports",
  "list_statement_rows",
  "lookup_upc",
  "patch_product_external_ids",
  "prepare_purchase_import",
  "preview_financial_statement_import",
  "propose_product_match",
  "record_statement_rows",
  "resolve_products",
  "schedule_image_processing",
  "update_statement_rows",
  "validate_purchase_import",
  "verify_product_images",
  "verify_products_images",
] as const;

export type CubbyMcpToolName =
  | (typeof PHOTO_MCP_TOOLS)[number]
  | (typeof PURCHASE_MCP_TOOLS)[number];

export type ImportRunAgentConfig = {
  /** OpenAI model id the Flue coordinator runs on. */
  model: "gpt-6-luna" | "gpt-6-sol";
  effort: "low" | "medium" | "high";
  agentTools: readonly ImportRunAgentToolName[];
  /** Flue sends every mounted tool's schema on every call, so list only what the workflow uses. */
  mcpTools: readonly CubbyMcpToolName[];
};

const purchaseAgent = {
  model: "gpt-6-sol",
  effort: "high",
  agentTools: IMPORT_RUN_AGENT_TOOLS,
  mcpTools: PURCHASE_MCP_TOOLS,
} satisfies ImportRunAgentConfig;

/**
 * Model, effort, and tools per agent run purpose. Photo grouping moved to Luna
 * after the live eval (`pnpm --dir apps/web eval:flue-models`) matched Sol on
 * every case at a fraction of the cost; purchase runs stay on Sol until the
 * same eval covers them.
 */
export const importRunAgentManifest = {
  photo_inventory: {
    model: "gpt-6-luna",
    effort: "medium",
    agentTools: [
      "claim_next_import_work",
      "report_agent_progress",
      "stop_import_run_for_review",
    ],
    mcpTools: PHOTO_MCP_TOOLS,
  },
  account_sync: purchaseAgent,
  purchase_validation: purchaseAgent,
  product_enrichment: purchaseAgent,
} as const satisfies Record<FlueImportRunPurpose, ImportRunAgentConfig>;
