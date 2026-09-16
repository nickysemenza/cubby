import { FLAGS } from "~/lib/flags";

export function useDebug() {
  return {
    isDebugEnabled: FLAGS.debugTables,
    isDevtoolsVisible: FLAGS.devtools,
  };
}
