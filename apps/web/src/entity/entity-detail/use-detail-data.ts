import type { DetailActivityInput } from "@cubby/schemas/entity-detail-data";
import { useInfiniteQuery } from "@tanstack/react-query";

import { cursorQueryOptions } from "~/integrations/tanstack-query/cursor-query-options";
import { entityGraph } from "~/integrations/tanstack-query/generated/catalog/entityGraph.gen";

export function useDetailActivity(input: DetailActivityInput, enabled = true) {
  return useInfiniteQuery({
    ...cursorQueryOptions(entityGraph.detailActivity, input),
    enabled,
  });
}
