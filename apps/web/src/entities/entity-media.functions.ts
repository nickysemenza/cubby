import { allEntities } from "@cubby/schemas/entity-manifest";

import { entityMediaContract } from "~/contracts/entity-media.contract";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

/** Display images may borrow through any manifest relationship. */
export const entityMedia = defineOperationDomain(entityMediaContract, {
  displayImages: {
    tags: [["relatedData"], ...allEntities.map((entity) => [entity] as const)],
  },
});
