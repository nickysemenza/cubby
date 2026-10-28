import { readDefinitions } from "~/entity/generated/entity-read-data.gen";
import { detailEntities } from "~/entity/generated/entity-read-keys.gen";

export { detailEntities };
export function getEntityDetailOutputSchema<
  E extends (typeof detailEntities)[number],
>(entity: E): (typeof readDefinitions)[E]["envelopes"]["detail"] {
  return readDefinitions[entity].envelopes.detail;
}
