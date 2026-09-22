"use agent";

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
import purchaseImportSkill from "../../../.claude/skills/purchase-import/SKILL.md";
import { serviceForCurrentRun } from "./cloudflare-service";
import { purchaseImportAgentIdentity } from "./contracts";
import { cubbyMcpConnection } from "./cubby-mcp";
import { installPurchaseImportTelemetry } from "./telemetry";
import { purchaseImportTools } from "./tools";

installPurchaseImportTelemetry();

// Flue applies this extension's `wrap` to the generated Durable Object class,
// which is where the Sentry SDK initializes for the agent isolate.
export { cloudflare } from "./sentry";

type ImportRunInitialData = {
  runId: string;
  coordinatorModel?: "gpt-5.6-terra" | "gpt-5.6-sol";
  purpose?: "account_sync" | "purchase_validation" | "product_enrichment";
};

/** One durable Flue conversation per authoritative ImportRun. */
export function PurchaseImportRun({ id }: AgentProps) {
  const {
    runId,
    coordinatorModel = "gpt-5.6-terra",
    purpose = "account_sync",
  } = useInitialData<ImportRunInitialData>();
  if (id !== purchaseImportAgentIdentity(runId)) {
    throw new Error(
      "Purchase import agent identity does not match its ImportRun",
    );
  }

  // The coordinator is intentionally fixed. Other registered provider models
  // exist for Flue internals and future bounded operations, not dynamic routing.
  useModel(`openai/${coordinatorModel}`, { thinkingLevel: "high" });
  useMcpConnection(cubbyMcpConnection(runId, serviceForCurrentRun));
  useSkill(purchaseImportSkill);
  useSkill(productEnrichmentSkill);

  // The run is named by its private id everywhere the agent speaks: the
  // public code can change without touching durable Flue state.
  useResponseStart(() => ({ jobKind: "purchase_import_run", runId }));
  useResponseFinish(({ response }) => ({
    usage: response.usage,
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
    const calls = response.toolCalls.length;
    if (calls === nudgedAt) return;
    setNudgedAt(calls);
    append({
      kind: "signal",
      type: "run_not_finished",
      body: "The run is still active. Continue the next selected order or hunt, or end it explicitly: call finish_import_run when every item is resolved or exhausted, or stop_import_run_for_review when evidence is ambiguous.",
    });
  });

  const tools = purchaseImportTools(runId, serviceForCurrentRun);
  useTool(tools[0]);
  useTool(tools[1]);
  useTool(tools[2]);
  useTool(tools[3]);
  useTool(tools[4]);
  useTool(tools[5]);
  useTool(tools[6]);
  useTool(tools[7]);
  useTool(tools[8]);
  useTool(tools[9]);
  useTool(tools[10]);

  return `You coordinate exactly one ${purpose} purchase-import run (runId ${runId}) with the complete Cubby MCP tool catalog.

Workflow:
1. Activate the purchase-import skill before doing any import work. Activate product-enrichment whenever an order line lacks a confident existing Product match.
2. Report the preparing phase and call claim_next_import_work. For receipt_evidence, call extract_receipt_evidence and use its immutable payload. For purchase_validation with uploaded run evidence, call extract_run_evidence and use its immutable payload; otherwise investigate the frozen source, use Gmail/read tools when no source claim exists, and use browser commands only when hasBrowserAccount is true and interactive vendor evidence is required. A pending browser command ends this submission; never poll or wait for it. A later queue event resumes this same durable conversation. After a browser result completes, call import_browser_order_evidence with its command id before using any capture metadata. Work kinds for account_sync: cursor_walk (navigate to startUrl with navigate_orders, then capture_screenshot the order-history page and import it — the server answers order_list with the orders it recorded, how many are pending, and nextPageUrl), order (capture_order at orderUrl and import it; the server marks it imported), hunt, product_enrichment, none. Never capture_order an order-history page. An order_list answer with nextPageUrl null means the history is exhausted for this run; an unreadable answer means capture again or stop for review, never prepare from it.
3. Call mcp__cubby__prepare_purchase_import exactly once per logical batch. Every mutation must carry _runExecution with this runId and stable operation ids. Derive them from durable source identities, keep item ids aligned with their orders, and reuse an id only to replay the identical logical effect.
4. Report investigating. Use read-only Cubby MCP tools and the product-enrichment skill to investigate every proposed Product resolution. Prefer exact existing Products and verified identifiers; do not create duplicates merely because a title differs. Before choosing new, check inventory-first Products (dataGap: product_unpurchased, same category/owner) and claim one when variant evidence agrees.
5. Preparation itself is bounded and never requires approval. Read the run purpose from the scoped tool result before choosing a terminal action. For account_sync, report committing then call mcp__cubby__commit_purchase_import with the immutable preparation revision and an explicit evidence-backed resolution for every principal line. For purchase_validation, call mcp__cubby__validate_purchase_import instead; it is the only permitted comparison path and must never be replaced with commit_purchase_import. For product_enrichment, use mcp__cubby__commit_product_enrichment only for blank manufacturer, category, or model, proven non-colliding identifiers, and at most one exact-variant image verified by the target's retained browser evidence. Use mcp__cubby__overwrite_product_enrichment for exactly one populated manufacturer, category, model, or cover-image replacement; an image replacement must repeat the exact evidence id, URL, and dimensions and it pauses for typed human approval. Price is never writable. Treat conflicts or unresolved identity as review: call stop_import_run_for_review and do not speculate.
6. Continue through every selected order and hunt. Persist safe same-domain navigation discoveries with save_navigation_hints. If the vendor proves older history unavailable, call mark_history_expired with the observed boundary. Only after all work is resolved or explicitly exhausted call finish_import_run; it performs the required auditor pass and is the only successful completion path. Never end a turn without one of: a pending browser command, awaiting_approval, finish_import_run, or stop_import_run_for_review — a report_agent_progress with phase review stops the run for review the same way stop_import_run_for_review does, and a run left without any of these is moved to review by the server.
7. If a genuinely necessary generic mutation reports paused_approval, report awaiting_approval with awaitingApproval=true and end the submission. Never self-approve, invent an approval id, or work around review. When a later authorized event resumes the run, read the persisted operation state and approval before continuing.

The server owns member identity, run scope, approval state, idempotency, and all writes. Imported Product and Expense writes must use commit_purchase_import. A generic mutation may be proposed only when genuinely needed outside that import write, must carry stable _runExecution identity, and may pause for exact typed human approval; never bypass, weaken, or rephrase an approval request. Shell, SQL, scripts, and arbitrary browser evaluation are forbidden. Browser commands are read-only and constrained by the server's vendor allowlist. Continue every selected order or hunt until it is imported, explicitly exhausted, awaiting approval, or stopped for review; one successful order does not finish an account scan. Authentication and offline states are resumable server states.`;
}

PurchaseImportRun.agentName = "purchase-import-run";
PurchaseImportRun.initialData = v.object({
  runId: v.pipe(v.string(), v.uuid()),
  coordinatorModel: v.optional(v.picklist(["gpt-5.6-terra", "gpt-5.6-sol"])),
  purpose: v.optional(
    v.picklist(["account_sync", "purchase_validation", "product_enrichment"]),
  ),
});
PurchaseImportRun.durability = { maxAttempts: 8, timeoutMs: 55 * 60 * 1_000 };
