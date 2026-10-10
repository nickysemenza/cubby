import type { OpenAiChatModel } from "@cubby/shared/ai/models";
import { z } from "zod";

import type {
  CubbyMcpToolAction,
  CubbyMcpToolName,
} from "./generated/mcp-tool-names.gen";
import { runEntityId } from "./identifier-fields";
import { runPurpose } from "./run-fields";

/** Purposes coordinated by the durable import-run agent. */
export const agentImportRunPurpose = runPurpose.extract([
  "mail_import",
  "photo_inventory",
]);
export type AgentImportRunPurpose = z.infer<typeof agentImportRunPurpose>;

// These prefixes are persisted in Run.agentSessionId and the agent's Durable
// Object storage. Existing conversations must retain their original identity.
const instancePrefix = {
  mail_import: "import-run",
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

/** The host-owned tools every agent mounts (apps/web/src/server/purchase-agent/tools.ts). */
const RUN_AGENT_TOOLS = [
  "claim_next_import_work",
  "report_agent_progress",
  "stop_import_run_for_review",
] as const;
export type ImportRunAgentToolName = (typeof RUN_AGENT_TOOLS)[number];

/** Mail import reads Email and writes through the same public tools a member uses. */
const MAIL_IMPORT_MCP_ACTIONS = [
  "imports_read.mail",
  "mail.search",
  "mail.resolve",
  "purchase_import.prepare",
  "purchase_import.commit",
  "entity_read.get",
  "entity_read.list",
  "entity_read.resolve",
  "search.global",
  "imports_read.external_id_collisions",
  "product_enrichment.propose_match",
] as const satisfies readonly CubbyMcpToolAction[];

const PHOTO_MCP_ACTIONS = [
  "imports_read.photo_context",
  "imports_read.image_processing",
  "imports_read.photo_candidates",
  "imports_read.photo_proposals",
  "entity_read.resolve",
  "search.similar",
  "photo_run.propose_groups",
  "entity.update",
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

/** Each purpose's model and authority: host tools plus narrowed MCP actions. */
export const importRunAgentManifest = {
  photo_inventory: {
    model: "gpt-6-luna",
    effort: "medium",
    agentTools: RUN_AGENT_TOOLS,
    mcpActions: PHOTO_MCP_ACTIONS,
    mcpTools: toolsOf(PHOTO_MCP_ACTIONS),
  },
  mail_import: {
    model: "gpt-6-luna",
    effort: "medium",
    agentTools: RUN_AGENT_TOOLS,
    mcpActions: MAIL_IMPORT_MCP_ACTIONS,
    mcpTools: toolsOf(MAIL_IMPORT_MCP_ACTIONS),
  },
} as const satisfies Record<AgentImportRunPurpose, ImportRunAgentConfig>;

/** The model a run row records as its coordinator. */
export function coordinatorModelFor(
  purpose: string,
): ImportRunAgentConfig["model"] {
  const parsed = agentImportRunPurpose.safeParse(purpose);
  return importRunAgentManifest[parsed.success ? parsed.data : "mail_import"]
    .model;
}
