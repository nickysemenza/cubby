import {
  type PublicImpactItem,
  publicImpactItemSchema,
} from "@cubby/schemas/entity-integrity";
import { AppErrors, getErrorMessage, type AppErrorReason } from "@cubby/shared";
import { z } from "zod";

import type { PublicStartValidationIssue } from "~/server/start-operation.contract";

import {
  type ErrorDiagnostics,
  errorDiagnosticsSchema,
} from "./error-diagnostics";

// Re-export from shared for convenience (22+ consumers)
export { getErrorMessage } from "@cubby/shared";

export const SUPERSEDED_VIEW_TRANSITION_MESSAGE =
  "Old view transition aborted by new view transition.";

const unparsedErrorSchema = z.unknown();
const namedErrorSchema = z.object({ name: z.string(), message: z.string() });
const appErrorReasonSchema = z.custom<AppErrorReason>(
  (value): value is AppErrorReason =>
    typeof value === "string" && value in AppErrors,
);

export type UnparsedError = z.input<typeof unparsedErrorSchema>;

function getNamedError(error: UnparsedError) {
  const parsed = namedErrorSchema.safeParse(error);
  return parsed.success ? parsed.data : null;
}

/**
 * Safari rejects the previous ViewTransition when a newer navigation wins.
 * Match only that browser-generated cancellation: a generic AbortError can
 * still represent a real failed loader/upload and must remain reportable.
 */
export function isSupersededViewTransitionError(error: UnparsedError): boolean {
  const details = getNamedError(error);
  if (!details) return false;
  return (
    details.name === "AbortError" &&
    details.message === SUPERSEDED_VIEW_TRANSITION_MESSAGE
  );
}

/** Errors emitted by browsers/Vite when a build's lazy chunk no longer exists. */
export function isDynamicImportError(error: UnparsedError): boolean {
  const details = getNamedError(error);
  if (!details) return false;
  if (details.name === "ChunkLoadError") return true;

  const message = details.message.toLowerCase();
  return (
    message.includes("failed to fetch dynamically imported module") ||
    message.includes("importing a module script failed") ||
    message.includes("error loading dynamically imported module") ||
    message.includes("failed to load module script") ||
    message.includes("unable to preload css for")
  );
}

const validationIssueSchema = z.object({
  code: z.string(),
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});

const transportErrorSchema = z.object({
  message: z.string(),
  data: z.object({
    requestId: z.string().optional().catch(undefined),
    diagnostics: errorDiagnosticsSchema.optional().catch(undefined),
    code: z.string().optional().catch(undefined),
    reason: appErrorReasonSchema.optional().catch(undefined),
    blockers: z.array(publicImpactItemSchema).optional().catch(undefined),
    validationIssues: z
      .array(validationIssueSchema)
      .optional()
      .catch(undefined),
  }),
});

type AppErrorDetails = {
  message: string;
  requestId?: string;
  diagnostics?: ErrorDiagnostics;
  code?: string;
  reason?: AppErrorReason;
  /**
   * Present when the server refused and could say what blocked it. These come
   * from the real mutation refusal itself.
   */
  blockers?: PublicImpactItem[];
  /**
   * Per-field refusals from the operation's own input schema. Path segments are
   * the schema path, so a form can attach each one beside the control it names
   * instead of flattening them into one sentence.
   */
  validationIssues?: PublicStartValidationIssue[];
};

export function getAppErrorDetails(error: UnparsedError): AppErrorDetails {
  const parsed = transportErrorSchema.safeParse(error);
  if (parsed.success) {
    const details: AppErrorDetails = { message: parsed.data.message };
    if (parsed.data.data.requestId)
      details.requestId = parsed.data.data.requestId;
    if (parsed.data.data.diagnostics)
      details.diagnostics = parsed.data.data.diagnostics;
    if (parsed.data.data.code) details.code = parsed.data.data.code;
    if (parsed.data.data.reason) details.reason = parsed.data.data.reason;
    if (parsed.data.data.blockers) {
      details.blockers = parsed.data.data.blockers;
    }
    if (parsed.data.data.validationIssues) {
      details.validationIssues = parsed.data.data.validationIssues;
    }
    return details;
  }
  return {
    message: getErrorMessage(error),
  };
}
