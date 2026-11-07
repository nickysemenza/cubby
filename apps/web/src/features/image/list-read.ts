import { specialistListReadProjection } from "~/entity/entity-list/list-read-demand";

export const imageListReadProjection = specialistListReadProjection({
  always: ["url", "status", "representations"],
  whenShown: { entity: ["associations"] },
});
