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
export type GatewayEgressInput = z.infer<typeof gatewayEgressInput>;
export const gatewayAdmission = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("admitted"), token: z.uuid() }),
  z.object({ kind: z.literal("wait"), until: z.number() }),
]);
export type GatewayAdmission = z.infer<typeof gatewayAdmission>;
export interface AiGatewayEgressRpc {
  fetch(request: Request): Promise<Response>;
  admit(bucket: string, now?: number): Promise<GatewayAdmission>;
  finish(
    token: string,
    status: number,
    retryAfter: string | null,
    now?: number,
  ): Promise<void>;
}
