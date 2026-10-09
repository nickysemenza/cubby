import { searchStreams } from "~/integrations/tanstack-query/generated/search.gen";

export const openSearchIndexRepairStream = (signal?: AbortSignal) =>
  searchStreams.repairIndex.open(undefined, { signal });
