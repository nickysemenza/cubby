import { productCategoryFeature } from "./product-category-fields";
import { positiveMoneyNullable } from "./money";
import {
  productQuantityLedgerOut,
  productPickerOnHand,
  productDisplayFactsState,
} from "./product-read-fields";
/** Repository/compiler projections. Public entity reads use generated field envelopes. */
import productDefinition from "./entity-definitions/00-product.entity";
import { z } from "zod";
import { foodSummary, foodSummaryCompact } from "@cubby/usda";
import { unitMappingOut } from "./unitmapping";
import { externalIdOut } from "./external-id";
import { recipeUsageMcpEntityOut } from "./recipe-fields";

export const rawProductOutput = productDefinition.readSchemas.output;
export const rawProductList = productDefinition.readSchemas.list;
export const rawProductDetail = productDefinition.readSchemas.detail;
export const rawProductWithMappings = rawProductOutput.extend({
  unitMappings: z.array(unitMappingOut),
});
export const rawProductWithMappingsAndFood = rawProductWithMappings.extend({
  food: foodSummary.nullable(),
});
const externalIds = z.array(externalIdOut.omit({ id: true }));
// Unit-mapping ids are existing follow-up write handles, unlike external-id rows.
export const rawProductMcpOutput = rawProductOutput.extend({ externalIds });
export const rawProductMcpList = rawProductList.extend({
  externalIds,
  unitMappings: z.array(unitMappingOut),
  food: foodSummaryCompact.nullable(),
});
export const rawProductMcpDetail = rawProductDetail.extend({
  externalIds,
  unitMappings: z.array(unitMappingOut),
  food: foodSummaryCompact.nullable(),
  recipeUsages: z.array(recipeUsageMcpEntityOut),
});

export type RawProductOutput = z.output<typeof rawProductOutput>;
export type RawProductList = z.output<typeof rawProductList>;
export type RawProductDetail = z.output<typeof rawProductDetail>;

export const rawProductMcpWithMappings = rawProductWithMappings.extend({
  externalIds,
  unitMappings: z.array(unitMappingOut),
});
export const rawProductMcpWithMappingsAndFood =
  rawProductWithMappingsAndFood.extend({
    externalIds,
    unitMappings: z.array(unitMappingOut),
    food: foodSummaryCompact.nullable(),
  });
export type RawProductWithMappings = z.output<typeof rawProductWithMappings>;
export type RawProductWithMappingsAndFood = z.output<
  typeof rawProductWithMappingsAndFood
>;

export {
  rawProductInventoryWithLocationOut,
  type RawProductListInventoryEntryOut,
} from "./product-read-fields";

/** Scalar search inputs retain private pricing/quantity hydration. */
export const rawProductResolveCandidate = z.object({
  id: rawProductOutput.shape.id,
  name: rawProductOutput.shape.name,
  brandId: rawProductOutput.shape.brandId,
  brandName: rawProductOutput.shape.brandName,
  category: rawProductOutput.shape.category,
  categoryFeature: productCategoryFeature.nullable(),
  price: positiveMoneyNullable,
  coverImageUrl: z.string().nullable(),
});
export const rawProductPickerItem = rawProductResolveCandidate.extend({
  quantityLedger: productQuantityLedgerOut.nullable(),
  onHand: z.union([
    productPickerOnHand,
    z.object({ state: z.literal("unavailable") }),
  ]),
  displayFacts: productDisplayFactsState,
});
export type RawProductPickerItem = z.output<typeof rawProductPickerItem>;
export type RawProductResolveCandidate = z.output<
  typeof rawProductResolveCandidate
>;
