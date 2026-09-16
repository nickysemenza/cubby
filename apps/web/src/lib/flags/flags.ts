const DEV = import.meta.env?.DEV ?? false;
// Vitest is DEV too; console tracing there only races the worker teardown.
const BROWSER_DEV = DEV && !(import.meta.env?.TEST ?? false);

/**
 * Feature-flag registry. Flags are compile-time constants (no persistence, no
 * runtime toggling) — flip a value here and reload to change behavior.
 */
export const FLAGS = {
  perfOverlay: false,
  debugTables: false,
  devtools: false,
  formDevtools: false,
  queryLogger: BROWSER_DEV,
  wasmSlowWarn: DEV,
  renderHighlight: false,
  verboseErrors: false,
} as const;
