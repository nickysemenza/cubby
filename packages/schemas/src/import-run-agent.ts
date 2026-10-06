import type { OpenAiChatModel } from "@cubby/shared/ai/models";
import { z } from "zod";

import type {
  CubbyMcpToolAction,
  CubbyMcpToolName,
} from "./generated/mcp-tool-names.gen";
import { runEntityId } from "./identifier-fields";
import { runPurpose } from "./run-fields";

/** Purposes currently coordinated by the durable import-run agent. */
export const agentImportRunPurpose = runPurpose.extract([
  "account_sync",
  "purchase_validation",
  "product_enrichment",
  "photo_inventory",
]);
export type AgentImportRunPurpose = z.infer<typeof agentImportRunPurpose>;

// These prefixes are persisted in Run.agentSessionId and the agent's Durable
// Object storage. Existing conversations must retain their original identity.
const instancePrefix = {
  account_sync: "import-run",
  purchase_validation: "import-run",
  product_enrichment: "import-run",
  photo_inventory: "photo-inventory",
} satisfies Record<AgentImportRunPurpose, string>;
const validPrefixes = new Set<string>(Object.values(instancePrefix));

export function importRunAgentIdentity(
  runId: string,
  purpose: AgentImportRunPurpose,
): string {
  return `${instancePrefix[purpose]}:${runEntityId.parse(runId)}`;
}

/** Resolve only agent-owned instances; other observations are ignored. */
export function importRunIdFromAgentIdentity(
  instanceId: string | undefined,
): string | undefined {
  if (!instanceId) return undefined;
  const colon = instanceId.indexOf(":");
  if (colon < 0) return undefined;
  const prefix = instanceId.slice(0, colon);
  if (!validPrefixes.has(prefix)) return undefined;
  return runEntityId.safeParse(instanceId.slice(colon + 1)).data;
}

/** The purchase agent's own tools (apps/web/src/server/purchase-agent/tools.ts). */
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
  "defer_order_for_review",
  "settle_charge_hunt",
] as const;
export type ImportRunAgentToolName = (typeof IMPORT_RUN_AGENT_TOOLS)[number];

const PHOTO_MCP_ACTIONS = [
  "imports_read.photo_context",
  "imports_read.image_processing",
  "imports_read.photo_candidates",
  "imports_read.photo_proposals",
  "entity_read.resolve",
  "search.similar",
  "photo_run.propose_groups",
  "product_enrichment.patch_external_ids",
] as const satisfies readonly CubbyMcpToolAction[];

// Actions purchase runs called in production plus those the purchase-import
// and product-enrichment skills (mounted on every purchase run) name.
const PURCHASE_MCP_ACTIONS = [
  "entity_read.get",
  "entity_read.list",
  "entity_read.search",
  "entity_read.relations",
  "entity_read.resolve",
  "entity.create",
  "entity.update",
  "entity.delete",
  "entity.merge",
  "entity.bulkUpdate",
  "entity.link",
  "entity.unlink",
  "entity.commands",
  "search.global",
  "search.similar",
  "finance_read.statement_rows",
  "finance_read.imports",
  "finance_read.drift",
  "finance_read.preview_import",
  "statement_rows.record",
  "statement_rows.update",
  "imports_read.purchase_status",
  "imports_read.vendor_coverage",
  "imports_read.external_id_collisions",
  "imports_read.upc_lookup",
  "purchase_import.prepare",
  "purchase_import.validate",
  "purchase_import.commit",
  "purchase_import.confirm_vendor",
  "product_enrichment.propose_match",
  "product_enrichment.patch_external_ids",
  "product_enrichment.verify_images",
  "image.schedule_processing",
] as const satisfies readonly CubbyMcpToolAction[];

/** The tools the coordinator mounts for a set of actions: it mounts by tool name. */
const toolsOf = <const Actions extends readonly CubbyMcpToolAction[]>(
  actions: Actions,
) =>
  // SAFETY: every generated action is `${tool}.${action}` with a dot-free
  // tool name, so the segment before the first dot is exactly that tool.
  [...new Set(actions.map((action) => action.split(".")[0]))] as Array<
    Actions[number] extends `${infer Tool}.${string}` ? Tool : never
  >;

export type ImportRunAgentConfig = {
  /** OpenAI model id the coordinator runs on. */
  model: OpenAiChatModel;
  effort: "low" | "medium" | "high";
  agentTools: readonly ImportRunAgentToolName[];
  /**
   * The coordinator mounts MCP tools by name and sends every mounted schema
   * on every call; Cubby narrows each mounted tool's advertised schema to
   * these actions and refuses any other action from the run.
   */
  mcpActions: readonly CubbyMcpToolAction[];
  mcpTools: readonly CubbyMcpToolName[];
};

const purchaseAgent = {
  model: "gpt-6-sol",
  effort: "high",
  agentTools: IMPORT_RUN_AGENT_TOOLS,
  mcpActions: PURCHASE_MCP_ACTIONS,
  mcpTools: toolsOf(PURCHASE_MCP_ACTIONS),
} satisfies ImportRunAgentConfig;

// Enrichment runs also commit what they verified; `enrichment_commit` is
// granted to the product_enrichment purpose only (server capability gate).
const ENRICHMENT_MCP_ACTIONS = [
  ...PURCHASE_MCP_ACTIONS,
  "product_enrichment.commit",
  "product_enrichment.skip",
  "product_enrichment.overwrite",
] as const satisfies readonly CubbyMcpToolAction[];

const enrichmentAgent = {
  ...purchaseAgent,
  mcpActions: ENRICHMENT_MCP_ACTIONS,
  mcpTools: toolsOf(ENRICHMENT_MCP_ACTIONS),
} satisfies ImportRunAgentConfig;

/**
 * Model, effort, and tools per agent run purpose. Photo grouping moved to Luna
 * after the live eval (`pnpm --dir apps/web eval:agent-models`) matched Sol on
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
    mcpActions: PHOTO_MCP_ACTIONS,
    mcpTools: toolsOf(PHOTO_MCP_ACTIONS),
  },
  account_sync: purchaseAgent,
  purchase_validation: purchaseAgent,
  product_enrichment: enrichmentAgent,
} as const satisfies Record<AgentImportRunPurpose, ImportRunAgentConfig>;

/**
 * The model a run row records as its coordinator. Any other purpose records
 * the account-sync coordinator, matching the column default.
 */
export function coordinatorModelFor(
  purpose: string,
): ImportRunAgentConfig["model"] {
  const parsed = agentImportRunPurpose.safeParse(purpose);
  return importRunAgentManifest[parsed.success ? parsed.data : "account_sync"]
    .model;
}
