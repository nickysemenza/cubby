import { publicImpactItemSchema } from "@cubby/schemas/entity-integrity";
import { z } from "zod";

import {
  type ErrorDiagnostics,
  errorDiagnosticsSchema,
} from "~/lib/error-diagnostics";

/**
 * The wire contract every operation shares. Server and browser both import
 * it, so it stays client-safe: types and schemas only.
 */

const publicStartValidationIssueSchema = z.object({
  code: z.string(),
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});

/**
 * Malformed diagnostics keep the error and its raw payload as a cause, so the
 * evidence survives instead of disappearing behind a schema failure.
 */
const malformedDiagnostics = (raw: unknown): ErrorDiagnostics => ({
  origin: "server",
  operation: "unknown",
  stage: "http",
  causes: [
    {
      name: "MalformedDiagnostics",
      message: JSON.stringify(raw) ?? String(raw),
    },
  ],
});

// `catch` (not `transform`) keeps the schema projectable to the native wire.
const diagnosticsSchema = errorDiagnosticsSchema
  .optional()
  .catch(({ value }) => malformedDiagnostics(value));

export const publicOperationErrorSchema = z.object({
  message: z.string(),
  code: z.string(),
  reason: z.string().optional(),
  /** Correlates this failed request with server-side traces and Sentry. */
  requestId: z.string().optional(),
  diagnostics: diagnosticsSchema,
  blockers: z.array(publicImpactItemSchema).optional(),
  validationIssues: z.array(publicStartValidationIssueSchema).optional(),
});

/** Plain-object branch of the recursive operation wire value. */
interface OperationProperties {
  readonly [key: string]: OperationWireValue;
}

/**
 * What an operation input or output may contain: JSON plus `Date`, which the
 * shared `dateTime` schema restores from its ISO string. Each operation's own
 * schemas validate the domain shape; this type only keeps callers honest at
 * compile time.
 */
export type OperationWireValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Date
  | readonly OperationWireValue[]
  | OperationProperties;

export const operationWireValueSchema = z.custom<OperationWireValue>();

export type PublicStartValidationIssue = z.infer<
  typeof publicStartValidationIssueSchema
>;
export type PublicOperationError = z.infer<typeof publicOperationErrorSchema>;
export type OperationResult<T> =
  | { ok: true; data: T; readMarker?: string }
  | { ok: false; error: PublicOperationError; readMarker?: string };

export const operationResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    data: operationWireValueSchema,
    readMarker: z.string().optional(),
  }),
  z.object({
    ok: z.literal(false),
    error: publicOperationErrorSchema,
    readMarker: z.string().optional(),
  }),
]);
