/**
 * The one place a `Location.type` column value becomes a `LocationType`.
 *
 * `type` is nullable: a location that IS a Product carries no form factor of
 * its own, because the SKU is its form factor. Only a *present* value is
 * validated against the enum.
 *
 * Its own leaf module because five different mappers need it — under
 * `location/`, `product/` and `inventory/` — and `location/helpers.ts` already
 * imports from `inventory/mappers.ts`, so hosting it in either would make the
 * pair circular. Same reason `identity-product.ts` sits beside it.
 *
 * **Why this is a function and not an inlined `parseWithContext` call.**
 * `parseWithContext` takes its value as `unknown`, so passing a
 * `string | null` into a non-nullable enum is not a type error — it throws at
 * runtime, on production data, in a mapper no test happened to feed a null.
 * That is exactly how five call sites survived a typecheck and 2,231 tests and
 * still broke the location detail page. Route every one through here.
 */

import { type LocationType, locationType } from "@cubby/schemas/location";

import { parseWithContext } from "~/lib/zod-utils";

export const parseLocationType = (
  value: string | null,
  identifier: { id: string; name: string },
): LocationType | null =>
  value === null
    ? null
    : parseWithContext(locationType, value, {
        entityType: "Location",
        identifier,
      });
