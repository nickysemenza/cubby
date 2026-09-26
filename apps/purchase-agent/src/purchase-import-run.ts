"use agent";

import {
  flueImportRunPurpose,
  importRunAgentIdentity,
  importRunAgentManifest,
  type FlueImportRunPurpose,
} from "@cubby/schemas/import-run-agent";
import {
  useAgentFinish,
  useInitialData,
  useMcpConnection,
  useModel,
  usePersistentState,
  useResponseFinish,
  useResponseStart,
  useSkill,
  useTool,
  type AgentProps,
} from "@flue/runtime";
import * as v from "valibot";

import productEnrichmentSkill from "../../../.claude/skills/product-enrichment/SKILL.md";
import { serviceForCurrentRun } from "./cloudflare-service";
import { takeContextBreakdown } from "./context-breakdown-scope";
import { cubbyMcpConnection } from "./cubby-mcp";
import { installImportRunTelemetry } from "./telemetry";
import { purchaseImportTools } from "./tools";
import { workflowForImportRun } from "./import-run-workflows";

installImportRunTelemetry();

// Flue applies this extension's `wrap` to the generated Durable Object class,
// which is where the Sentry SDK initializes for the agent isolate.
export { cloudflare } from "./sentry";

type ImportRunInitialData = {
  runId: string;
  coordinatorModel?: string;
  purpose?: FlueImportRunPurpose;
};

/** One durable Flue conversation per authoritative ImportRun. */
export function PurchaseImportRun({ id }: AgentProps) {
  const { runId, purpose = "account_sync" } =
    useInitialData<ImportRunInitialData>();
  if (id !== importRunAgentIdentity(runId, purpose)) {
    throw new Error("Flue agent identity does not match its ImportRun");
  }

  const manifest = importRunAgentManifest[purpose];
  useModel(`openai/${manifest.model}`, { thinkingLevel: manifest.effort });
  useMcpConnection(cubbyMcpConnection(runId, serviceForCurrentRun, purpose));
  const workflow = workflowForImportRun(purpose, runId);
  useSkill(workflow.skill);
  useSkill(productEnrichmentSkill);

  // The run is named by its private id everywhere the agent speaks: the
  // public code can change without touching durable Flue state.
  useResponseStart(() => ({ runId }));
  // Section sizes of this response's model calls, never their text; the run
  // page draws "Context per call" from it.
  useResponseFinish(({ response }) => ({
    usage: response.usage,
    contextBreakdown: takeContextBreakdown(),
  }));

  // The model may stop talking without a terminal tool call. Tools that
  // legitimately end a submission (`issue_browser_command` pending,
  // `report_agent_progress` approval/review, finish, stop) terminate before
  // this hook runs, so reaching it means the run is still `running` with no
  // work in flight. Send the model back once per stretch of new tool calls;
  // if it stops again without doing anything, let the submission settle and
  // the server's reconcile moves the run to review.
  const [nudgedAt, setNudgedAt] = usePersistentState(
    "finishNudgeToolCalls",
    -1,
  );
  useAgentFinish(({ response, append }) => {
    if (!workflow.finishNudge) return;
    const calls = response.toolCalls.length;
    if (calls === nudgedAt) return;
    setNudgedAt(calls);
    append({
      kind: "signal",
      type: "run_not_finished",
      body: workflow.finishNudge,
    });
  });

  // Mounted by name from the manifest; purpose is fixed for a durable run, so
  // the set is stable across renders.
  for (const tool of purchaseImportTools(runId, serviceForCurrentRun))
    // oxlint-disable-next-line react-hooks/rules-of-hooks
    if (manifest.agentTools.some((name) => name === tool.name)) useTool(tool);

  return workflow.instructions;
}

// The exported name and agentName determine the deployed Durable Object class.
// Keep both stable while the workflow behind them supports multiple purposes.
PurchaseImportRun.agentName = "purchase-import-run";
PurchaseImportRun.initialData = v.object({
  runId: v.pipe(v.string(), v.uuid()),
  coordinatorModel: v.optional(v.string()),
  purpose: v.optional(v.picklist(flueImportRunPurpose.options)),
});
PurchaseImportRun.durability = { maxAttempts: 8, timeoutMs: 55 * 60 * 1_000 };
