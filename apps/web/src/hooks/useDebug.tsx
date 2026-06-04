import type { ReactNode } from "react";
import { getFlag, setFlag, useFlag } from "~/lib/flags";

/**
 * Back-compat shim. The two debug toggles now live in the feature-flag store
 * (the source of truth, surfaced on /settings) using the same localStorage keys
 * they always did, so existing state and consumers keep working unchanged.
 *
 * `DebugContextProvider` is a no-op passthrough kept so existing mounts don't
 * need editing; the flag store needs no provider.
 */
export function DebugContextProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function useDebug() {
  const isDebugEnabled = useFlag("debugTables");
  const isDevtoolsVisible = useFlag("devtools");
  return {
    isDebugEnabled,
    toggleDebug: () => setFlag("debugTables", !getFlag("debugTables")),
    isDevtoolsVisible,
    toggleDevtools: () => setFlag("devtools", !getFlag("devtools")),
  };
}
