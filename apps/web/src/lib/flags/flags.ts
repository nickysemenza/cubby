/**
 * Feature-flag registry. Each flag is a boolean toggle persisted in localStorage
 * and surfaced on the /settings Developer page. Flags can be flipped in any
 * environment (they are NOT build-time stripped) — see `store.ts` for the
 * synchronous `getFlag` used on hot paths and the `useFlag` hook for components.
 */
interface FlagDef {
  /** localStorage key (kept stable across releases so users keep their state). */
  storageKey: string;
  label: string;
  description: string;
  /** Default when unset. Use `import.meta.env.DEV` to be on-in-dev, off-in-prod. */
  default: boolean;
  group: FlagGroup;
  /**
   * The thing this flag controls is build-time stripped from production bundles
   * (e.g. a devtools panel removed by a Vite plugin), so the toggle is a dead
   * no-op in prod. When true, the settings page hides the row in non-dev builds
   * instead of showing a control that can never do anything.
   */
  devBuildOnly?: boolean;
}

export type FlagGroup = "Developer" | "Experimental";

export const FLAGS = {
  perfOverlay: {
    storageKey: "perfOverlay",
    label: "Performance overlay",
    description:
      "Floating panel with live WASM, query, render, runtime and Web-Vitals stats.",
    default: false,
    group: "Developer",
  },
  debugTables: {
    // Pre-existing key from useDebug — keep so current users keep their setting.
    storageKey: "debugTablesEnabled",
    label: "Debug table columns",
    description: "Show ids and timestamps in data tables and detail pages.",
    default: false,
    group: "Developer",
  },
  devtools: {
    // Pre-existing key from useDebug.
    storageKey: "devtoolsVisible",
    label: "TanStack devtools",
    description: "Show the Query / Router devtools panel.",
    default: false,
    group: "Developer",
    // @tanstack/devtools-vite strips the panel from production builds.
    devBuildOnly: true,
  },
  formDevtools: {
    storageKey: "formDevtools",
    label: "React Hook Form devtools",
    description: "Show the react-hook-form devtools panel on forms.",
    default: false,
    group: "Developer",
    // The @hookform/devtools import is tree-shaken from production builds
    // (FORM_DEVTOOLS_BUNDLED in form-utils.tsx).
    devBuildOnly: true,
  },
  queryLogger: {
    storageKey: "queryLogger",
    label: "tRPC query logger",
    description: "Log every tRPC query/mutation to the console.",
    default: import.meta.env.DEV,
    group: "Developer",
  },
  wasmSlowWarn: {
    storageKey: "wasmSlowWarn",
    label: "WASM slow-call warnings",
    description:
      "console.warn when a single WASM call exceeds one frame (16ms).",
    default: import.meta.env.DEV,
    group: "Developer",
  },
  renderHighlight: {
    storageKey: "renderHighlight",
    label: "Highlight re-renders",
    description: "Outline profiled components each time they commit.",
    default: false,
    group: "Developer",
  },
  verboseErrors: {
    storageKey: "verboseErrors",
    label: "Verbose error toasts",
    description: "Show full error details instead of friendly messages.",
    default: false,
    group: "Developer",
  },
} as const satisfies Record<string, FlagDef>;

export type FlagKey = keyof typeof FLAGS;

export const FLAG_KEYS = Object.keys(FLAGS) as FlagKey[];

/**
 * Whether a flag's target is build-stripped from production bundles, making the
 * toggle a no-op there. The `as FlagDef` widens the `as const` literal (which
 * omits the optional `devBuildOnly` from flags that don't set it) so the field
 * is readable uniformly across the union.
 */
export function isDevBuildOnlyFlag(key: FlagKey): boolean {
  return (FLAGS[key] as FlagDef).devBuildOnly === true;
}
