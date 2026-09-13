import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import type { ReactNode } from "react";

/**
 * Human toast payload for a mutation's persisted side-effects.
 *
 * `sideEffects.backgroundBatches` is a wire-compatibility remnant of the
 * removed background-job ledger — always empty, kept only so existing
 * generated clients keep decoding (see `@cubby/schemas/background-jobs`).
 * There is nothing left to link to, so this always returns the plain
 * "Saved."-style toast; the parameter stays for every call site's existing
 * `savedWithBackgroundWork(data.sideEffects, ...)` shape.
 */
export const savedWithBackgroundWork = (
  _s: MutationSideEffects,
  base = "Saved",
): ReactNode => `${base}.`;
