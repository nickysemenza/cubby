import {
  entityDisplayImagesInput,
  entityDisplayImagesOutput,
} from "@cubby/schemas/entity-media";

import { defineContract, query } from "~/contracts/define";

/** Browser-only canonical media lookup for compact entity references. */
export const entityMediaContract = defineContract("entityMedia", {
  displayImages: query({
    http: false,
    input: entityDisplayImagesInput,
    output: entityDisplayImagesOutput,
  }),
});
