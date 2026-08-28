import {
  type PublicImpactItem,
  publicImpactItemSchema,
} from "@cubby/schemas/entity-integrity";
import type { AppErrorReason } from "@cubby/shared";
import { getErrorMessage } from "@cubby/shared";
import { z } from "zod";

import type { PublicStartValidationIssue } from "~/server/start-operation.contract";

// Re-export from shared for convenience (22+ consumers)
export { getErrorMessage } from "@cubby/shared";

export const SUPERSEDED_VIEW_TRANSITION_MESSAGE =
  "Old view transition aborted by new view transition.";

function getNamedError(
  error: unknown,
): { name: string; message: string } | null {
  if (typeof error !== "object" || error === null) return null;
  if (!("name" in error) || !("message" in error)) return null;
  if (typeof error.name !== "string" || typeof error.message !== "string") {
    return null;
  }
  return { name: error.name, message: error.message };
}

/**
 * Safari rejects the previous ViewTransition when a newer navigation wins.
 * Match only that browser-generated cancellation: a generic AbortError can
 * still represent a real failed loader/upload and must remain reportable.
 */
export function isSupersededViewTransitionError(error: unknown): boolean {
  const details = getNamedError(error);
  if (!details) return false;
  return (
    details.name === "AbortError" &&
    details.message === SUPERSEDED_VIEW_TRANSITION_MESSAGE
  );
}

/** Errors emitted by browsers/Vite when a build's lazy chunk no longer exists. */
export function isDynamicImportError(error: unknown): boolean {
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

type TransportError = {
  message: string;
  data: {
    code?: unknown;
    reason?: unknown;
    blockers?: unknown;
    validationIssues?: unknown;
  };
};

const validationIssueSchema = z.object({
  code: z.string(),
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});

function isTransportError(err: unknown): err is TransportError {
  if (typeof err !== "object" || err === null) return false;
  const obj = err as Record<string, unknown>;
  const messageOk = typeof obj.message === "string";
  const dataOk = typeof obj.data === "object" && obj.data !== null;
  return messageOk && dataOk;
}

type AppErrorDetails = {
  message: string;
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

export function getAppErrorDetails(error: unknown): AppErrorDetails {
  if (isTransportError(error)) {
    const code = error.data.code as string | undefined;
    const d = error.data as Record<string, unknown>;
    const reason = typeof d?.reason === "string" ? d.reason : undefined;
    // Re-validated on arrival: `error.data` is server-shaped but untyped here,
    // and a malformed payload should read as "no blockers", not crash a toast.
    const parsedBlockers = z
      .array(publicImpactItemSchema)
      .safeParse(d?.blockers);
    const parsedIssues = z
      .array(validationIssueSchema)
      .safeParse(d?.validationIssues);
    return {
      message: error.message,
      code,
      reason: reason as AppErrorReason | undefined,
      ...(parsedBlockers.success ? { blockers: parsedBlockers.data } : {}),
      ...(parsedIssues.success ? { validationIssues: parsedIssues.data } : {}),
    };
  }
  return {
    message: getErrorMessage(error),
  };
}
