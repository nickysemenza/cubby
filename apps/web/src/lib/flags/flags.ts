const DEV = import.meta.env?.DEV ?? false;

/**
 * Feature-flag registry. Flags are compile-time constants (no persistence, no
 * runtime toggling) — flip a value here and reload to change behavior.
 */
export const FLAGS = {
  perfOverlay: false,
  debugTables: false,
  devtools: false,
  formDevtools: false,
  queryLogger: DEV,
  wasmSlowWarn: DEV,
  renderHighlight: false,
  verboseErrors: false,
} as const;
