import { problemsStreams } from "~/integrations/tanstack-query/domains/problemsStreams";

export const openProblemsReparseStream = (signal?: AbortSignal) =>
  problemsStreams.reparseStale.open(undefined, { signal });
export const openProblemsPruneAliasesStream = (signal?: AbortSignal) =>
  problemsStreams.pruneAllUnusedAliases.open(undefined, { signal });
