import { z } from "zod";
import { unitMappingBase } from "~/schemas/unitmapping";
import { locationBase } from "~/schemas/location";
import { ndb, upc } from "~/schemas/identifiers";

const newProductConfig = z.object({
  name: z.string(),
  upc: upc.optional(),
  ndb_number: ndb.optional(),
  manufacturer: z.string(),
  model: z.string().optional(),

  ingredient: z
    .boolean()
    .optional()
    .describe(
      "if the product is an ingredient, an ingredient with the same name will be created and linked to this product",
    ),
  unit_mappings: z.array(unitMappingBase).optional(),
  price_per: z
    .number()
    .optional()
    .describe("price per each, shorthand for unit_mappings"),
});
// .merge(productBase);

const productReferenceConfig = z.object({ name: z.string() });

const locationWithProductHint = locationBase.extend({
  products: z.lazy(() => newProductConfig.array().optional()),
  productReferences: z.lazy(() => productReferenceConfig.array().optional()),
});
export type InfLocationConfig = z.infer<typeof locationWithProductHint> & {
  children?: InfLocationConfig[];
};

const locationConfigEntry: z.ZodType<InfLocationConfig> =
  locationWithProductHint.extend({
    children: z.lazy(() => locationConfigEntry.array().optional()),
  });

export type ProductConfigItem = z.infer<typeof newProductConfig>;
export type ProductReferenceItem = z.infer<typeof productReferenceConfig>;

export const configSchema = z
  .object({
    locations: locationConfigEntry
      .array()
      .describe("locations that have inventoryable items"),
    products: newProductConfig
      .array()
      .describe("products that can be purchased"),
    aliases: z.record(z.array(z.string())).optional(),
  })
  .describe("system config");

export type DataConfig = z.infer<typeof configSchema>;
