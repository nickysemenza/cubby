import type { AppErrorReason } from "@cubby/shared";
import { getErrorMessage } from "@cubby/shared";
import type { TRPCClientErrorLike } from "@trpc/client";
import type { AppRouter } from "~/server/api/root";

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

function isTRPCClientError(
  err: unknown,
): err is TRPCClientErrorLike<AppRouter> {
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
};

export function getAppErrorDetails(error: unknown): AppErrorDetails {
  if (isTRPCClientError(error)) {
    const code = error.data?.code as string | undefined;
    const reason = (() => {
      const d = error.data as Record<string, unknown> | undefined;
      const r = d?.reason;
      return typeof r === "string" ? (r as AppErrorReason) : undefined;
    })();
    return {
      message: error.message,
      code,
      reason,
    };
  }
  return {
    message: getErrorMessage(error),
  };
}
