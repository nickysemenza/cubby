import { WISH_PURCHASED_READ_FIELDS } from "~/entity/actions/action-read-fields";
import { specialistListReadProjection } from "~/entity/entity-list/list-read-demand";

export const wishListReadProjection = specialistListReadProjection({
  always: ["candidates", ...WISH_PURCHASED_READ_FIELDS],
  whenShown: { candidateCount: ["candidateCount"], priceRange: ["priceRange"] },
});
