import { z } from "zod";
import {
  unitMappingFlexible,
  unitMappingBase,
  transformUnitMapping,
} from "~/schemas/unitmapping";
import { locationBase } from "~/schemas/location";
import { ndb, upc } from "~/schemas/identifiers";

// Base product config schema with shared fields
const baseProductConfig = z.object({
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
  aliases: z
    .array(z.string())
    .optional()
    .describe("alternative names for this ingredient"),
  price_per: z
    .number()
    .optional()
    .describe("price per each, shorthand for unit_mappings"),
});

// Input product config - what we parse from YAML (strings)
const newProductConfigInput = baseProductConfig.extend({
  unit_mappings: z.array(unitMappingFlexible).optional(),
});

// Output product config - what the backend expects (transformed objects)
const newProductConfigOutput = baseProductConfig.extend({
  unit_mappings: z.array(unitMappingBase).optional(),
});

const productReferenceConfig = z.object({ name: z.string() });

// Input location schema (with strings)
const locationWithProductHintInput = locationBase.extend({
  products: z.lazy(() => newProductConfigInput.array().optional()),
  productReferences: z.lazy(() => productReferenceConfig.array().optional()),
});

// Output location schema (with transformed objects)
const locationWithProductHintOutput = locationBase.extend({
  products: z.lazy(() => newProductConfigOutput.array().optional()),
  productReferences: z.lazy(() => productReferenceConfig.array().optional()),
});

export type InfLocationConfigInput = z.infer<
  typeof locationWithProductHintInput
> & {
  children?: InfLocationConfigInput[];
};

type InfLocationConfigOutput = z.infer<typeof locationWithProductHintOutput> & {
  children?: InfLocationConfigOutput[];
};

const locationConfigEntryInput: z.ZodType<InfLocationConfigInput> =
  locationWithProductHintInput.extend({
    children: z.lazy(() => locationConfigEntryInput.array().optional()),
  });

const locationConfigEntryOutput: z.ZodType<InfLocationConfigOutput> =
  locationWithProductHintOutput.extend({
    children: z.lazy(() => locationConfigEntryOutput.array().optional()),
  });

// Input config schema - what we parse from YAML
export const configSchema = z
  .object({
    locations: locationConfigEntryInput
      .array()
      .describe("locations that have inventoryable items"),
    products: newProductConfigInput
      .array()
      .describe("products that can be purchased"),
    aliases: z.record(z.string(), z.array(z.string())).optional(),
  })
  .describe("system config");

// Output types (derived from Zod schemas)
export type InfLocationConfig = InfLocationConfigOutput;
export type ProductConfigItem = z.infer<typeof newProductConfigOutput>;
export type ProductConfigItemInput = z.infer<typeof newProductConfigInput>;
export type ProductReferenceItem = z.infer<typeof productReferenceConfig>;
export type DataConfig = z.infer<typeof configSchema>;

// Transform function to convert input to output
export function transformConfig(input: DataConfig): {
  locations: InfLocationConfig[];
  products: ProductConfigItem[];
  aliases?: Record<string, string[]>;
} {
  return {
    ...input,
    locations: transformLocations(input.locations),
    products: input.products.map(transformProduct),
  };
}

function transformProduct(product: ProductConfigItemInput): ProductConfigItem {
  return {
    ...product,
    unit_mappings: product.unit_mappings?.map(transformUnitMapping),
  };
}

function transformLocations(
  locations: InfLocationConfigInput[],
): InfLocationConfig[] {
  return locations.map(transformLocation);
}

function transformLocation(
  location: InfLocationConfigInput,
): InfLocationConfig {
  return {
    ...location,
    products: location.products?.map(transformProduct),
    children: location.children?.map(transformLocation),
  };
}
