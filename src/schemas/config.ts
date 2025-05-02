import { z } from "zod";
import { unitMappingBase } from "~/schemas/unitmapping";
import { locationBase } from "~/schemas/location";
import { ndb, upc } from "./util";

const eproductConfig = z.object({
  name: z.string(),
  upc: upc.optional(),
  ndb_number: ndb.optional(),
  manufacturer: z.string(),
  model: z.string().optional(),

  ingredient: z.boolean().optional(),
  unit_mappings: z.array(unitMappingBase).optional(),
  // price_per is shorthand for unit_mappings
  price_per: z.number().optional(),
});
export const productConfig = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("product"), data: eproductConfig }),
  z.object({ kind: z.literal("reference"), name: z.string() }),
]);

const locationWithProductHint = locationBase.extend({
  products: z.lazy(() => productConfig.array().optional()),
});
export type InfLocationConfig = z.infer<typeof locationWithProductHint> & {
  children?: InfLocationConfig[];
};

const locationConfigEntry: z.ZodType<InfLocationConfig> =
  locationWithProductHint.extend({
    children: z.lazy(() => locationConfigEntry.array().optional()),
  });

export type ProductConfigItem = z.infer<typeof productConfig>;

export const configSchema = z
  .object({
    locations: locationConfigEntry
      .array()
      .describe("locations that have inventoryable items"),
    products: productConfig.array().describe("products that can be purchased"),
    aliases: z.record(z.array(z.string())).optional(),
  })
  .describe("system config");

export type DataConfig = z.infer<typeof configSchema>;
