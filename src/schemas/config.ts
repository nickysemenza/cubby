import { z } from "zod";
import { unitMappingBase } from "~/schemas/unitmapping";
import { locationBase } from "~/schemas/location";
import { upc } from "./util";

export const productConfig = z.object({
  name: z.string(),
  upc: upc.optional(),
  manufacturer: z.string(),
  model: z.string().optional(),

  ingredient: z.boolean().optional(),
  unit_mappings: z.array(unitMappingBase).optional(),

  price_per: z.number().optional(),
});

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
