/**
 * Every stored derived value's compute adapter, by the `compute` id its
 * declaration names (ADR 0021). The drain looks adapters up here only.
 */
import { inventoryDerivedComputes } from "~/server/domains/inventory/repo/derived";
import { locationDerivedComputes } from "~/server/domains/location/repo/derived";
import { productDerivedComputes } from "~/server/domains/product/repo/derived";
import { projectDerivedComputes } from "~/server/domains/project/repo/derived";
import type { DerivedComputes } from "~/server/generic/derived/repo/compute";

export const derivedComputes: DerivedComputes = {
  ...productDerivedComputes,
  ...inventoryDerivedComputes,
  ...locationDerivedComputes,
  ...projectDerivedComputes,
};
