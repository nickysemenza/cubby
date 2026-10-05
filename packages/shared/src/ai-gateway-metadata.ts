import { z } from "zod";

/**
 * The one AI Gateway every Cubby caller bills through: production, CI, live
 * evals, and integration-enabled local development alike. `environment`
 * metadata, not a separate gateway, tells their traffic apart.
 */
export const CUBBY_AI_GATEWAY_ID = "cubby";

export const aiGatewayEnvironmentSchema = z.enum([
  "production",
  "ci",
  "development",
]);
export type AiGatewayEnvironment = z.infer<typeof aiGatewayEnvironmentSchema>;

/**
 * Everything Cubby sends as `cf-aig-metadata`. The gateway keeps five entries
 * and a spend-limit rule split by a key gets one budget per distinct value,
 * so only low-cardinality labels belong here. Run, batch, chunk, and entity
 * ids stay in the AiUsage ledger and correlate through `cf-aig-log-id`.
 * Strict: a new key is a contract change, not a silent passenger.
 */
export const aiGatewayMetadataSchema = z.strictObject({
  environment: aiGatewayEnvironmentSchema,
  feature: z.string().min(1),
  operation: z.string().min(1),
  entityKind: z.string().min(1).optional(),
});
export type AiGatewayMetadata = z.output<typeof aiGatewayMetadataSchema>;

/** What a caller labels; the transport boundary adds `environment`. */
export type AiGatewayCallMetadata = Omit<AiGatewayMetadata, "environment">;

/** A process that runs only for tests or tooling: CI on a runner, else local. */
export function testAiGatewayEnvironment(
  ci: string | undefined,
): AiGatewayEnvironment {
  return ci && ci !== "false" && ci !== "0" ? "ci" : "development";
}

/**
 * The environment of the app runtime (Worker or Node server). Only runtime
 * variables count: the deploy build runs on a CI runner, so a build-time `CI`
 * must never relabel the deployed Worker, whose wrangler vars are
 * `NODE_ENV=production` and `E2E_AUTH_TEST_MODE=false`.
 */
export function aiGatewayEnvironment(vars: {
  NODE_ENV?: string;
  E2E_AUTH_TEST_MODE?: string;
  CI?: string;
}): AiGatewayEnvironment {
  if (vars.NODE_ENV === "test" || vars.E2E_AUTH_TEST_MODE === "true")
    return testAiGatewayEnvironment(vars.CI);
  return vars.NODE_ENV === "production" ? "production" : "development";
}

const forwardedLabels = z.object({
  feature: z.string().min(1),
  operation: z.string().min(1),
  entityKind: z.string().min(1).optional(),
});

/**
 * A test proxy's outbound metadata: the caller's feature, operation, and
 * entity kind from its `cf-aig-metadata`, with the proxy's own environment
 * (the caller ran inside a harness that cannot tell CI from a laptop). Any
 * other key is dropped; a missing or unreadable header gets `fallback`.
 */
export function proxiedAiGatewayMetadata(
  header: string | null,
  environment: AiGatewayEnvironment,
  fallback: Omit<AiGatewayCallMetadata, "entityKind">,
): AiGatewayMetadata {
  let labels: AiGatewayCallMetadata = fallback;
  try {
    const parsed = forwardedLabels.safeParse(JSON.parse(header ?? "null"));
    if (parsed.success) labels = parsed.data;
  } catch {
    // SILENT: an unreadable header is attributed to the proxy's fallback.
  }
  return aiGatewayMetadataSchema.parse({ ...labels, environment });
}
