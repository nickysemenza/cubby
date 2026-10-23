import { aiGatewayMetadataSchema } from "@cubby/shared/ai/gateway-metadata";
import { gatewayProviderSchema } from "@cubby/shared/ai/models";
import { z } from "zod";

// Checked 2026-10-20: Unified Billing is 200 requests/60s/gateway (BYOK
// excluded); Cubby reserves 20 for other clients. Workers AI defaults are
// 300 RPM text generation / 2,000 classification, with no published fixed
// concurrency ceiling. 64 unified permits leave >2x the 30 needed at 10s.
// https://developers.cloudflare.com/ai-gateway/reference/limits/
// https://developers.cloudflare.com/workers-ai/platform/limits/
// Anthropic BYOK has organization/model RPM and token limits, not one universal
// concurrency number: honor its 429 Retry-After without inventing a flat cap.
// https://platform.claude.com/docs/en/api/rate-limits
// ChatGPT plan transport bypasses AI Gateway; its plan-dependent usage limits
// publish no fixed concurrency allowance and it has no local fan-out cap.
// https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan
/** What the egress Durable Object admits; the Run page's limits catalog reads the same values. */
export const GATEWAY_EGRESS_LIMITS = {
  windowMs: 60_000,
  requestsPerWindow: 180,
  unifiedMaxInFlight: 64,
  requestDeadlineMs: 10 * 60_000,
} as const;

/** Conservative initial direct-provider admission; bytes bound input tokens above. */
export const TYPESAFE_EGRESS_LIMITS = {
  windowMs: 1_000,
  requestsPerWindow: 20,
  inputTokensPerWindow: 80_000,
  maxInFlight: 16,
} as const;

export const isDirectJevEndpoint = (provider: string, endpoint: string) =>
  provider === "workers-ai" && endpoint === "run/typesafe/jev";

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
  z.object({
    kind: z.literal("admitted"),
    token: z.uuid(),
    // Credit admissions: the refusal epoch their response is observed under.
    epoch: z.number().optional(),
  }),
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
  currentDeploymentVersion(): Promise<string>;
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
