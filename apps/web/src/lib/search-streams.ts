import { searchStreams } from "~/integrations/tanstack-query/generated/catalog.gen";

export const openSearchIndexRepairStream = (signal?: AbortSignal) =>
  searchStreams.repairIndex.open(undefined, { signal });
