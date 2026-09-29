import {
  entityDisplayImagesInput,
  entityDisplayImagesOutput,
} from "@cubby/schemas/entity-media";

import { ENTITY_ROOT_TAGS } from "~/contracts/cache-policy";
import { defineContract, query } from "~/contracts/define";

/** Browser-only canonical media lookup for compact entity references. */
export const entityMediaContract = defineContract("entityMedia", {
  displayImages: query({
    http: false,
    input: entityDisplayImagesInput,
    output: entityDisplayImagesOutput,
    cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
  }),
});
