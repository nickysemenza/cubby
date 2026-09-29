/**
 * The one place a `Location.type` column value becomes a `LocationType`.
 *
 * `type` is NOT NULL: a Product-instance location stores the explicit type
 * `furniture` (see `locationTypeValues`), so every row carries a form factor.
 * Its own leaf module because five different mappers need it — under
 * `location/`, `product/` and `inventory/` — and `location/helpers.ts` already
 * imports from `inventory/mappers.ts`, so hosting it in either would make the
 * pair circular. Same reason `identity-product.ts` sits beside it.
 */

import { type LocationType, locationType } from "@cubby/schemas/location";

export const parseLocationType = (value: string): LocationType =>
  locationType.parse(value);
