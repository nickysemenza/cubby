/**
 * The web Worker's named WorkerEntrypoint is the only authority over Cubby's
 * database, documents, browser broker, and member ownership. This Worker has
 * no database or browser bindings by design. The input shapes are the shared
 * RPC contract (`@cubby/schemas/purchase-agent-rpc`), also what the
 * entrypoint in `apps/web/src/cf-server.ts` takes its types from.
 */
import type {
  AgentProgressEvent,
  AgentUsageEvent,
  auditBatchInput,
  deferOrderForReviewInput,
  importOrderEvidenceInput,
  issueBrowserCommandInput,
  markHistoryExpiredInput,
  markRunFailedInput,
  purchaseAgentEventRef,
  purchaseAgentOperationRef,
  purchaseAgentRunRef,
  reconcileSettledRunInput,
  saveNavigationHintsInput,
  settleChargeHuntInput,
  stopForReviewInput,
} from "@cubby/schemas/purchase-agent-rpc";
import { z } from "zod";

const purchaseImportServiceResult = z
  .record(z.string(), z.unknown())
  .nullable();
type PurchaseImportServiceResult = z.infer<typeof purchaseImportServiceResult>;

interface PurchaseImportMcpAccess {
  token: string;
  expiresAt: string;
  mcpUrl: string;
}

type RunRef = z.infer<typeof purchaseAgentRunRef>;
type EventRef = z.infer<typeof purchaseAgentEventRef>;
type OperationRef = z.infer<typeof purchaseAgentOperationRef>;

export interface PurchaseImportService {
  loadRunScope(input: RunRef): Promise<PurchaseImportServiceResult>;
  canDispatchCoordinator(input: EventRef): Promise<boolean>;
  acknowledgeCoordinator(input: EventRef): Promise<boolean>;
  claimNextWork(input: OperationRef): Promise<PurchaseImportServiceResult>;
  extractReceiptEvidence(
    input: OperationRef,
  ): Promise<PurchaseImportServiceResult>;
  extractRunEvidence(input: OperationRef): Promise<PurchaseImportServiceResult>;
  acquireMcpAccess(input: RunRef): Promise<PurchaseImportMcpAccess>;
  mcpFetch(request: Request): Promise<Response>;
  issueBrowserCommand(
    input: z.infer<typeof issueBrowserCommandInput>,
  ): Promise<PurchaseImportServiceResult>;
  readBrowserCommandResult(
    input: OperationRef,
  ): Promise<PurchaseImportServiceResult>;
  importOrderEvidence(
    input: z.infer<typeof importOrderEvidenceInput>,
  ): Promise<PurchaseImportServiceResult>;
  saveNavigationHints(
    input: z.infer<typeof saveNavigationHintsInput>,
  ): Promise<PurchaseImportServiceResult>;
  markHistoryExpired(
    input: z.infer<typeof markHistoryExpiredInput>,
  ): Promise<PurchaseImportServiceResult>;
  auditBatch(
    input: z.infer<typeof auditBatchInput>,
  ): Promise<PurchaseImportServiceResult>;
  finishRun(input: OperationRef): Promise<PurchaseImportServiceResult>;
  stopForReview(
    input: z.infer<typeof stopForReviewInput>,
  ): Promise<PurchaseImportServiceResult>;
  deferOrderForReview(
    input: z.infer<typeof deferOrderForReviewInput>,
  ): Promise<PurchaseImportServiceResult>;
  settleChargeHunt(
    input: z.infer<typeof settleChargeHuntInput>,
  ): Promise<PurchaseImportServiceResult>;
  recordAgentUsage(input: AgentUsageEvent): Promise<void>;
  updateAgentProgress(
    input: AgentProgressEvent,
  ): Promise<{ recorded: boolean }>;
  markRunFailed(
    input: z.infer<typeof markRunFailedInput>,
  ): Promise<PurchaseImportServiceResult>;
  reconcileSettledRun(
    input: z.infer<typeof reconcileSettledRunInput>,
  ): Promise<{ reconciled: boolean; status: string }>;
}

const serviceBindingSchema = z.object({
  CUBBY_PURCHASE_SERVICE: z.custom<PurchaseImportService>(),
});

// `env` is validated here, so it stays `unknown`: typing it as the agent's
// `CloudflareContext["env"]` drags the whole agent runtime (pi-ai, openai,
// typebox) into the web typecheck through `mac-import-continuation-peer.ts`.
export function purchaseImportService(env: unknown): PurchaseImportService {
  return serviceBindingSchema.parse(env).CUBBY_PURCHASE_SERVICE;
}
