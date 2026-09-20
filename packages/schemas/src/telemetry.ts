import { z } from "zod";
import { entitySchema } from "./entity-core";
import { queueMessageEnvelope } from "./queue-messages";

const telemetryEnvelope = {
  ...queueMessageEnvelope,
  queueType: z.literal("telemetry"),
  eventId: z.uuid(),
  occurredAt: z.iso.datetime(),
  release: z.string().min(1),
};

export const mcpToolCallOutcomeSchema = z.enum(["success", "error"]);
export type McpToolCallOutcome = z.infer<typeof mcpToolCallOutcomeSchema>;

export const mcpToolCallSurfaceSchema = z.enum([
  "external_mcp",
  "in_app_agent",
]);
export type McpToolCallSurface = z.infer<typeof mcpToolCallSurfaceSchema>;

export const mcpToolCallTelemetrySchema = z.strictObject({
  ...telemetryEnvelope,
  type: z.literal("mcp_tool_call"),
  toolName: z.string().min(1),
  outcome: mcpToolCallOutcomeSchema,
  registeredAtCall: z.boolean(),
  surface: mcpToolCallSurfaceSchema,
  userId: z.string().min(1),
  clientId: z.string().min(1).nullable(),
  // Deliberately `.optional()`, not required: in-flight Cloudflare Queue
  // messages minted by the currently-deployed worker (before this field
  // existed) have no `entity` key at all. A required field would reject them
  // on replay — this schema validates messages that can be up to a queue's
  // retry window old, not just ones from the version deploying right now.
  entity: entitySchema.optional(),
});
export type McpToolCallTelemetry = z.infer<typeof mcpToolCallTelemetrySchema>;

export const aiUsageTelemetrySchema = z.strictObject({
  ...telemetryEnvelope,
  type: z.literal("ai_usage"),
  feature: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  operation: z.string().min(1),
  // A durable import/audit job can issue several model calls. Keep the
  // correlation optional so queue messages from the preceding deployment
  // continue to validate and land as ungrouped historical telemetry.
  jobKind: z.string().min(1).nullable().optional(),
  jobId: z.string().min(1).nullable().optional(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  // Prompt-cache token counts, when the provider reports them. Optional keeps
  // telemetry queued by the preceding deployment forward-compatible.
  cacheReadTokens: z.number().int().nonnegative().nullable().optional(),
  cacheWriteTokens: z.number().int().nonnegative().nullable().optional(),
  attempt: z.number().int().positive().optional(),
  status: z.enum(["succeeded", "failed"]).optional(),
  gatewayLogId: z.string().min(1).nullable().optional(),
  durationMs: z.number().int().nonnegative(),
  cacheStatus: z.enum(["hit", "miss", "none"]).nullable(),
  entityType: z.string().min(1).nullable(),
  entityId: z.uuid().nullable(),
  // The caller's own cost figure (the cookbook crate prices every model it
  // calls); absent on messages minted before this field existed and for
  // callers that leave pricing to the app-side registry.
  estimatedCost: z.number().nonnegative().nullable().optional(),
});
export type AiUsageTelemetry = z.infer<typeof aiUsageTelemetrySchema>;

export const telemetryMessageV1Schema = z.discriminatedUnion("type", [
  mcpToolCallTelemetrySchema,
  aiUsageTelemetrySchema,
]);
export type TelemetryMessageV1 = z.infer<typeof telemetryMessageV1Schema>;

export const mcpTelemetryIdentitySchema = z.strictObject({
  userId: z.string().min(1),
  clientId: z.string().min(1).nullable(),
  surface: mcpToolCallSurfaceSchema,
});
export type McpTelemetryIdentity = z.infer<typeof mcpTelemetryIdentitySchema>;

export const mcpUsageWindowSchema = z.union([
  z.literal(7),
  z.literal(30),
  z.literal(90),
  z.literal(180),
  z.literal("lifetime"),
]);
export type McpUsageWindow = z.infer<typeof mcpUsageWindowSchema>;

export const mcpToolUsageStatusSchema = z.enum([
  "active",
  "inactive",
  "never",
  "retired",
]);
export type McpToolUsageStatus = z.infer<typeof mcpToolUsageStatusSchema>;

const usageUserSchema = z.strictObject({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
});

const usageClientSchema = z.strictObject({
  id: z.string().nullable(),
  name: z.string().nullable(),
});

export const mcpUsageDashboardInput = z.strictObject({
  window: mcpUsageWindowSchema.default(90),
});

const dailyUsageSchema = z.strictObject({
  day: z.string(),
  success: z.number().int().nonnegative(),
  error: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

const toolAnnotationsSchema = z.strictObject({
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});

const jsonObjectSchema = z.record(z.string(), z.unknown());
const jsonValueObjectSchema = z.record(z.string(), z.json());

const mcpCatalogToolSchema = z.strictObject({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: jsonValueObjectSchema,
  outputSchema: jsonValueObjectSchema.optional(),
  annotations: toolAnnotationsSchema.optional(),
  _meta: jsonValueObjectSchema.optional(),
});

export const mcpToolCatalogOut = z.strictObject({
  tools: z.array(mcpCatalogToolSchema),
  instructions: z.string(),
});

const mcpToolUsageRowSchema = z.strictObject({
  toolName: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  inputSchema: jsonObjectSchema.nullable(),
  outputSchema: jsonObjectSchema.nullable(),
  annotations: toolAnnotationsSchema.nullable(),
  status: mcpToolUsageStatusSchema,
  registered: z.boolean(),
  lifetimeCalls: z.number().int().nonnegative(),
  periodCalls: z.number().int().nonnegative(),
  periodSuccesses: z.number().int().nonnegative(),
  periodErrors: z.number().int().nonnegative(),
  firstUsedAt: z.coerce.date().nullable(),
  lastUsedAt: z.coerce.date().nullable(),
  lastRelease: z.string().nullable(),
  daily: z.array(dailyUsageSchema),
  users: z.array(usageUserSchema),
  clients: z.array(usageClientSchema),
});

const mcpToolUsageBrowserRowSchema = mcpToolUsageRowSchema.extend({
  inputSchema: jsonValueObjectSchema.nullable(),
  outputSchema: jsonValueObjectSchema.nullable(),
});

const usageBreakdownSchema = z.strictObject({
  key: z.string(),
  label: z.string(),
  count: z.number().int().nonnegative(),
});

export const mcpUsageDashboardOut = z.strictObject({
  window: mcpUsageWindowSchema,
  observationStartedAt: z.coerce.date().nullable(),
  observationComplete: z.boolean(),
  totals: z.strictObject({
    registered: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    inactive: z.number().int().nonnegative(),
    never: z.number().int().nonnegative(),
    retired: z.number().int().nonnegative(),
    calls: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  }),
  daily: z.array(dailyUsageSchema),
  tools: z.array(mcpToolUsageRowSchema),
  users: z.array(usageBreakdownSchema),
  clients: z.array(usageBreakdownSchema),
  surfaces: z.array(usageBreakdownSchema),
  // Which entity each call targeted, where derivable — see `entity` on
  // `mcpToolCallTelemetrySchema`. A `delete_entity`/`merge_entity`/
  // `attach_entity`/`detach_entity` row without this would otherwise be
  // indistinguishable from every other row under the same collapsed
  // `toolName`; the "unknown" bucket covers tool families this can't be
  // derived for (find_*, patch_*, verify_*, statement/usda/problems, and
  // any row minted before this field existed).
  entities: z.array(usageBreakdownSchema),
});

export const mcpUsageDashboardBrowserOut = mcpUsageDashboardOut.extend({
  tools: z.array(mcpToolUsageBrowserRowSchema),
});

export const mcpUsageActivityInput = z.strictObject({
  window: mcpUsageWindowSchema.default(90),
  toolName: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  clientId: z.string().min(1).nullable().optional(),
  surface: mcpToolCallSurfaceSchema.optional(),
  outcome: mcpToolCallOutcomeSchema.optional(),
  entity: entitySchema.optional(),
  cursor: z.string().optional(),
  direction: z.enum(["forward", "backward"]).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export const mcpUsageActivityOut = z.strictObject({
  entries: z.array(
    z.strictObject({
      id: z.uuid(),
      toolName: z.string(),
      outcome: mcpToolCallOutcomeSchema,
      registeredAtCall: z.boolean(),
      surface: mcpToolCallSurfaceSchema,
      entity: entitySchema.nullable(),
      release: z.string(),
      occurredAt: z.coerce.date(),
      ingestedAt: z.coerce.date(),
      user: usageUserSchema,
      client: usageClientSchema,
    }),
  ),
  nextCursor: z.string().nullable(),
});

export type McpUsageDashboardOut = z.infer<typeof mcpUsageDashboardOut>;
export type McpUsageActivityOut = z.infer<typeof mcpUsageActivityOut>;
