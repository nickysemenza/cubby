import { getFlag, setFlag, useFlag } from "~/lib/flags";

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
