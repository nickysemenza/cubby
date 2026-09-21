import type { UnparsedError } from "~/lib/error-utils";

/**
 * Module-level store for the error-details dialog, so `showErrorToast`
 * (called from anywhere — query/mutation error handlers, non-component code)
 * can open it without React context. Deliberately has no React/component
 * imports: `error-details.tsx` imports from here, and
 * `error-details-dialog.tsx` imports from both, so importing a component
 * here would create a cycle. `~/lib/error-utils` is a type-only import (erased
 * at build time) and imports nothing from this module, so it doesn't risk one.
 */

export interface ErrorDetailsDialogState {
  open: boolean;
  error: UnparsedError;
}

let state: ErrorDetailsDialogState = { open: false, error: null };
const listeners = new Set<() => void>();

const SERVER_SNAPSHOT: ErrorDetailsDialogState = { open: false, error: null };

function notify() {
  for (const listener of listeners) listener();
}

export function openErrorDetailsDialog(error: UnparsedError): void {
  state = { open: true, error };
  notify();
}

/**
 * Only flips `open` — keeps the last `error` around so the dialog's exit
 * animation renders the previous content instead of an empty body.
 */
export function closeErrorDetailsDialog(): void {
  state = { ...state, open: false };
  notify();
}

export function subscribeErrorDetailsDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getErrorDetailsDialogSnapshot(): ErrorDetailsDialogState {
  return state;
}

export function getErrorDetailsDialogServerSnapshot(): ErrorDetailsDialogState {
  return SERVER_SNAPSHOT;
}
