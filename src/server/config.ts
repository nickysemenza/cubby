import { z } from "zod";
import { locationBase } from "./api/routers/locations";
import { amount } from "~/codec/codec";
import { b } from "vitest/dist/chunks/suite.BJU7kdY9.js";

const locationConfigBase = locationBase;

export type InfLocationConfig = z.infer<typeof locationConfigBase> & {
  children?: InfLocationConfig[];
};

const locationConfigEntry: z.ZodType<InfLocationConfig> =
  locationConfigBase.extend({
    children: z.lazy(() => locationConfigEntry.array().optional()),
  });

const productConfigEntry = z.object({
  name: z.string(),
  upc: z.string().length(12),
  manufacturer: z.string(),
  model: z.string().optional(),
  unit_mappings: z.array(
    z.object({
      a: amount.describe("first of pair"),
      b: amount.describe("second of pair"),
      source: z.string().optional(),
    }),
  ),
});

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
