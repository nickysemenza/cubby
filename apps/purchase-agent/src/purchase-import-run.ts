"use agent";

import {
  flueImportRunPurpose,
  importRunAgentIdentity,
  importRunAgentManifest,
  type FlueImportRunPurpose,
} from "@cubby/schemas/import-run-agent";
import {
  useAgentFinish,
  useAgentStart,
  useInitialData,
  useMcpConnection,
  useModel,
  usePersistentState,
  useResponseFinish,
  useResponseStart,
  useSkill,
  useTool,
  type AgentProps,
  type StateSetter,
} from "@flue/runtime";
import * as v from "valibot";

import productEnrichmentSkill from "../../../.claude/skills/product-enrichment/SKILL.md";
import { serviceForCurrentRun } from "./cloudflare-service";
import { takeContextBreakdown } from "./context-breakdown-scope";
import { cubbyMcpConnection } from "./cubby-mcp";
import { installRunTelemetry } from "./telemetry";
import { purchaseImportTools } from "./tools";
import { workflowForRun } from "./import-run-workflows";

installRunTelemetry();

// Flue applies this extension's `wrap` to the generated Durable Object class,
// which is where the Sentry SDK initializes for the agent isolate.
export { cloudflare } from "./sentry";

type RunInitialData = {
  runId: string;
  coordinatorModel?: string;
  purpose?: FlueImportRunPurpose;
};

/** The live value behind a state setter, which a render's value is not. */
function currentState<T>(setState: StateSetter<T>): T {
  let current: T | undefined;
  setState((previous) => (current = previous));
  // SAFETY: the functional update runs synchronously with the live value.
  return current as T;
}

/** One durable Flue conversation per authoritative Run. */
export function PurchaseImportRun({ id }: AgentProps) {
  const { runId, purpose = "account_sync" } = useInitialData<RunInitialData>();
  if (id !== importRunAgentIdentity(runId, purpose)) {
    throw new Error("Flue agent identity does not match its Run");
  }

  const manifest = importRunAgentManifest[purpose];
  useModel(`openai/${manifest.model}`, { thinkingLevel: manifest.effort });
  useMcpConnection(cubbyMcpConnection(runId, serviceForCurrentRun, purpose));
  const workflow = workflowForRun(purpose, runId);
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

  // The model may stop talking without a terminal tool call. Send it back
  // once per stretch of new tool calls; if it stops again without doing
  // anything, let the submission settle and the server's reconcile moves the
  // run to review. Flue also runs this hook after a tool that legitimately
  // ends the submission (`issue_browser_command` pending,
  // `report_agent_progress` approval/review, finish, stop), so those tools
  // mark the response settled and the hook leaves it alone; each delivery,
  // including browser evidence joining the live response, clears the mark.
  //
  // Flue re-runs this hook within one response without re-rendering, so the
  // render's state values go stale after the first cycle: read them through
  // the setters. A stale guard nudged a waiting run every cycle into Flue's
  // 32-cycle runaway ceiling.
  const [, setSettledByTool] = usePersistentState("finishSettledByTool", false);
  const [, setNudgedAt] = usePersistentState("finishNudgeToolCalls", -1);
  useAgentStart(() => setSettledByTool(false));
  useAgentFinish(({ response, append }) => {
    if (!workflow.finishNudge) return;
    if (currentState(setSettledByTool)) return;
    const calls = response.toolCalls.length;
    if (currentState(setNudgedAt) === calls) return;
    setNudgedAt(calls);
    append({
      kind: "signal",
      type: "run_not_finished",
      body: workflow.finishNudge,
    });
  });

  // Mounted by name from the manifest; purpose is fixed for a durable run, so
  // the set is stable across renders.
  for (const tool of purchaseImportTools(runId, serviceForCurrentRun, () =>
    setSettledByTool(true),
  ))
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
