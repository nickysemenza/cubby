import { aiGatewayMetadataSchema } from "@cubby/shared/ai/gateway-metadata";
import { gatewayProviderSchema } from "@cubby/shared/ai/models";
import { z } from "zod";

export const gatewayEgressInput = z.object({
  provider: gatewayProviderSchema,
  endpoint: z.string().min(1),
  headers: z.record(z.string(), z.string()).default({}),
  query: z.record(z.string(), z.json()),
  controls: z.object({
    metadata: aiGatewayMetadataSchema,
    skipCache: z.boolean().optional(),
    cacheTtl: z.number().optional(),
    requestTimeoutMs: z.number().positive().optional(),
    collectPayload: z.boolean().optional(),
  }),
});
const gatewayAdmission = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("admitted"), token: z.uuid() }),
  z.object({ kind: z.literal("wait"), until: z.number() }),
  // A recorded provider credit refusal: refused now, with no upstream call.
  z.object({
    kind: z.literal("refused"),
    until: z.number(),
    reason: z.string(),
  }),
]);
export type GatewayAdmission = z.infer<typeof gatewayAdmission>;
/** `reason` is the provider's raw refusal body; `until` is epoch ms. */
export type CreditRefusal = Omit<
  Extract<GatewayAdmission, { kind: "refused" }>,
  "kind"
>;
export interface AiGatewayEgressRpc {
  scheduleAiWorkRecovery(runId?: string): Promise<void>;
  scheduleFundingResume(at: number): Promise<void>;
  fetch(request: Request): Promise<Response>;
  admit(bucket: string, now?: number): Promise<GatewayAdmission>;
  creditRefusal(now?: number): Promise<CreditRefusal | null>;
  resetCreditRefusal(): Promise<void>;
  noteCreditResponse(status: number, body: string, now?: number): Promise<void>;
  finish(
    token: string,
    status: number,
    retryAfter: string | null,
    now?: number,
  ): Promise<void>;
}
