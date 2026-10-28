import { searchStreams } from "~/integrations/tanstack-query/domains/searchStreams";

export const openSearchIndexRepairStream = (signal?: AbortSignal) =>
  searchStreams.repairIndex.open(undefined, { signal });
