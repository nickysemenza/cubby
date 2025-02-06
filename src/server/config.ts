import { z } from "zod";
import { ItemType } from "@prisma/client";
import { productBase, unitMappingBase } from "~/schemas/item";
import { locationBase } from "~/schemas/locations";

export type InfLocationConfig = z.infer<typeof locationBase> & {
  children?: InfLocationConfig[];
};

const locationConfigEntry: z.ZodType<InfLocationConfig> = locationBase.extend({
  children: z.lazy(() => locationConfigEntry.array().optional()),
});

const productAddonConf = z.object({
  productType: z.nativeEnum(ItemType),
  unit_mappings: z.array(unitMappingBase),
});
const productConfigEntry = productBase.merge(productAddonConf);

export type ProductConfigItem = z.infer<typeof productConfigEntry>;

export const configSchema = z
  .object({
    locations: locationConfigEntry
      .array()
      .describe("locations that have inventoryable items"),
    products: productConfigEntry
      .array()
      .describe("products that can be purchased"),
  })
  .describe("system config");

export type Config = z.infer<typeof configSchema>;
