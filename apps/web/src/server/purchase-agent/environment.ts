/**
 * Everything the purchase agent can reach. The agent reads untrusted vendor
 * pages, mail, and photos, so it holds no database, binding, secret, or raw
 * Worker `env`: the host (`server/purchase-import/agent-host.ts`) builds this
 * narrowed environment, and every Cubby effect is a method of one Run's
 * services (`server/purchase-import/agent-services.ts`), which parses its
 * input (`@cubby/schemas/purchase-agent-services`) and resolves authority
 * from that Run. `tools/oxlint/cubby` keeps this directory from importing
 * anything else (docs/infrastructure.md#purchase-agent).
 */
import type { AgentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import type {
  AgentProgressEvent,
  AgentUsageEvent,
  deferOrderForReviewInput,
  importOrderEvidenceInput,
  issueBrowserCommandInput,
  markHistoryExpiredInput,
  markRunFailedInput,
  purchaseAgentOperationRef,
  reconcileSettledRunInput,
  saveNavigationHintsInput,
  settleChargeHuntInput,
  stopForReviewInput,
} from "@cubby/schemas/purchase-agent-services";
import type {
  AiGatewayEnvironment,
  AiGatewayMetadata,
} from "@cubby/shared/ai-gateway-metadata";
import type { gatewayQuery } from "@cubby/shared/ai-gateway-request";
import type { JSONType, z } from "zod";

import type { AgentSignal } from "./signals";

/** One mounted Cubby MCP tool as the model sees it. */
export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: { [key: string]: JSONType };
};

/** One queue event for a Run's coordinator. */
export type DispatchInput = {
  identity: { runId: string; purpose: AgentImportRunPurpose };
  operationId: string;
  signal: AgentSignal;
};

/** The coordinator Durable Object's RPC surface. */
export interface PurchaseImportRunAgentRpc {
  dispatch(input: DispatchInput): Promise<{ accepted: boolean }>;
}

/** A service result: the host's JSON answer, or null when there is none. */
type RunServiceResult = object | null;

type OperationRef = z.input<typeof purchaseAgentOperationRef>;

/** One Run's services. No method takes a Run: the host bound it. */
export interface RunServices {
  /**
   * Require the member's live Purchase Agent grant before a new coordinator
   * starts; without one the host pauses the Run for authorization and throws.
   */
  authorize(): Promise<void>;
  /** The Run's public identity: its purpose and agent instance name. */
  loadScope(): Promise<{ purpose: AgentImportRunPurpose; agentId: string }>;
  canDispatchCoordinator(eventId: string): Promise<boolean>;
  acknowledgeCoordinator(eventId: string): Promise<boolean>;
  claimNextWork(input: OperationRef): Promise<RunServiceResult>;
  extractReceiptEvidence(input: OperationRef): Promise<RunServiceResult>;
  extractRunEvidence(input: OperationRef): Promise<RunServiceResult>;
  /**
   * One request to Cubby's MCP server, in process. The host mints a fresh
   * run-bound delegation bearer for it; the agent never holds the token.
   */
  mcpFetch(request: Request): Promise<Response>;
  issueBrowserCommand(
    input: z.input<typeof issueBrowserCommandInput>,
  ): Promise<RunServiceResult>;
  readBrowserCommandResult(input: OperationRef): Promise<RunServiceResult>;
  importOrderEvidence(
    input: z.input<typeof importOrderEvidenceInput>,
  ): Promise<RunServiceResult>;
  saveNavigationHints(
    input: z.input<typeof saveNavigationHintsInput>,
  ): Promise<RunServiceResult>;
  markHistoryExpired(
    input: z.input<typeof markHistoryExpiredInput>,
  ): Promise<RunServiceResult>;
  finishRun(input: OperationRef): Promise<RunServiceResult>;
  stopForReview(
    input: z.input<typeof stopForReviewInput>,
  ): Promise<RunServiceResult>;
  deferOrderForReview(
    input: z.input<typeof deferOrderForReviewInput>,
  ): Promise<RunServiceResult>;
  settleChargeHunt(
    input: z.input<typeof settleChargeHuntInput>,
  ): Promise<RunServiceResult>;
  recordAgentUsage(input: AgentUsageEvent): Promise<void>;
  updateAgentProgress(
    input: Omit<AgentProgressEvent, "runId">,
  ): Promise<{ recorded: boolean }>;
  markRunFailed(
    input: z.input<typeof markRunFailedInput>,
  ): Promise<RunServiceResult>;
  reconcileSettledRun(
    input: z.input<typeof reconcileSettledRunInput>,
  ): Promise<{ reconciled: boolean; status: string }>;
}

/** Cubby's AI Gateway as the model providers call it (`AiGateway.run`). */
export interface AgentGateway {
  readonly id: string;
  /** The runtime's `environment` label for every call's metadata. */
  readonly environment: AiGatewayEnvironment;
  run(
    request: {
      provider: string;
      endpoint: string;
      headers: Record<string, string>;
      query: unknown;
    },
    options: {
      gateway: { id: string; metadata: AiGatewayMetadata };
      signal?: AbortSignal;
    },
  ): Promise<Response>;
}

/**
 * The household's ChatGPT plan: null only when no plan is connected. A
 * connected plan calls `onSelected` before inference and throws on failure,
 * so the call is never retried through the paid gateway.
 */
export type ChatGptInference = (
  body: Awaited<ReturnType<typeof gatewayQuery>>,
  options?: {
    signal?: AbortSignal;
    requestTimeoutMs?: number;
    onSelected?: () => void;
  },
) => Promise<Response | null>;

/**
 * The narrowed environment of one coordinator Durable Object. Its services
 * are bound to the Run its object name identifies, so the agent cannot
 * address another Run.
 */
export interface PurchaseAgentEnvironment {
  /** Cubby's AI Gateway through the Worker's AI binding. */
  gateway(): AgentGateway;
  /** Returns null only when the household has no ChatGPT plan connection. */
  chatGptInference?: ChatGptInference;
  /** The services of this object's Run. */
  readonly services: RunServices;
  /**
   * The purpose's Cubby MCP tools as the server describes them to the agent,
   * derived from the same compiled catalog the MCP server lists.
   */
  mcpTools(purpose: AgentImportRunPurpose): Promise<McpToolDefinition[]>;
  /** Workerd harness only: the scripted model peer replacing the Gateway. */
  testModel?: { fetch(request: Request): Promise<Response> };
}

/** The narrowed environment of the queue consumer, which serves every Run. */
export interface PurchaseAgentQueueEnvironment {
  /** The services of the Run an event names. */
  run(runId: string): RunServices;
  /** The coordinator Durable Object for an agent identity. */
  coordinator(agentId: string): PurchaseImportRunAgentRpc;
}

/** One `cubby-purchase-agent` delivery. */
export interface PurchaseAgentQueueDeliveredMessage {
  /** Raw queue JSON; only parsePurchaseAgentEvent narrows it to an event. */
  readonly body: unknown;
  /** Delivery attempts, starting at 1. */
  readonly attempts: number;
  ack(): void;
  retry(): void;
}

export interface PurchaseAgentQueueBatch {
  readonly queue: "cubby-purchase-agent";
  readonly messages: readonly PurchaseAgentQueueDeliveredMessage[];
}
