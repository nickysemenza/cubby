import { searchStreams } from "~/integrations/tanstack-query/generated/domains/searchStreams.gen";

/** The pass has no known population; retain the button's indeterminate pending state. */
export const openSearchIndexRepairStream = async (signal?: AbortSignal) => {
  const stream = await searchStreams.repairIndex.open(undefined, { signal });
  return (async function* () {
    for await (const event of stream) if (event.type === "done") yield event;
  })();
};
