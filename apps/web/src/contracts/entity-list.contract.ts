import { z } from "zod";

import { defineContract, query } from "~/contracts/define";
import {
  type EntityListInputByEntity,
  type EntityListResultByEntity,
  listEntities,
  type ListEntity,
} from "~/entities/generated/entity-lists.gen";

export const entityListContract = defineContract("entity", {
  list: query({
    // Type-only carriers: the per-entity runtime schemas live in the generated
    // list bindings and are applied by the browser `parse` policy and the
    // server handler; the HTTP router substitutes the real wire schema.
    input: z.custom<EntityListInputByEntity[ListEntity]>(),
    output: z.custom<EntityListResultByEntity[ListEntity]>(),
    // HTTP serves these as the per-entity resource routes instead.
    http: false,
    observability: { entities: listEntities },
  }),
});
