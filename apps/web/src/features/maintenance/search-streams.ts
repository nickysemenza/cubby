import { searchStreams } from "~/integrations/tanstack-query/generated/domains/searchStreams.gen";

export const openSearchIndexRepairStream = (signal?: AbortSignal) =>
  searchStreams.repairIndex.open(undefined, { signal });
