import type { MutationSideEffects } from "@cubby/schemas/mutation-side-effects";
import type { ReactNode } from "react";
import { toast } from "sonner";

/**
 * Human toast payload for a mutation's persisted side-effects.
 *
 * The background-job ledger is gone, so there is nothing left to link to and
 * this always returns the plain
 * "Saved."-style toast; the parameter stays for every call site's existing
 * `savedWithBackgroundWork(data.sideEffects, ...)` shape.
 */
export const savedWithBackgroundWork = (
  _s: MutationSideEffects,
  base = "Saved",
): ReactNode => `${base}.`;

/**
 * A mutation can succeed while a best-effort follow-up (e.g. a UPC
 * cover-photo import) fails; the server reports those as raw diagnostics in
 * `sideEffects.warnings`, and each one gets its own warning toast beside the
 * success toast.
 */
export const toastMutationWarnings = (
  sideEffects: MutationSideEffects | undefined,
): void => {
  for (const warning of sideEffects?.warnings ?? []) toast.warning(warning);
};
