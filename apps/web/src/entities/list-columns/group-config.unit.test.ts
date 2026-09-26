/**
 * A `GroupConfig.field` is sent to the server as the `groupBy` query param
 * (see `useEntityList.tsx`'s `groupByField`). The server's `parseGroupBy`
 * (`server/entity-kernel/entity-operations.ts`) only accepts a value from
 * that entity's declared `sort.groupable` allowlist and throws
 * `LIST_GROUP_BY_FIELD_UNSUPPORTED` for anything else — so a `field` that
 * isn't in the generated allowlist breaks grouping for every request as soon
 * as it reaches the server, not just in some edge case.
 *
 * CUBBY bug: the product list override declared `field: "category"`, but
 * the product entity only declares `categoryId` groupable
 * (`packages/schemas/src/entity-definitions/00-product.entity.ts`), so
 * grouping the product list threw on every request.
 */
import { generatedEntitySort } from "@cubby/schemas/entity-sort";
import { describe, expect, it } from "vitest";

import { LOCATION_GROUP_CONFIG } from "./location";
import { PRODUCT_GROUP_CONFIG } from "./product";

describe("declared list GroupConfig.field is server-groupable", () => {
  it.each([
    ["product", PRODUCT_GROUP_CONFIG] as const,
    ["location", LOCATION_GROUP_CONFIG] as const,
  ])("%s", (entity, config) => {
    const groupable = generatedEntitySort[entity].groupable;
    expect(groupable).toContain(config.field);
  });
});
