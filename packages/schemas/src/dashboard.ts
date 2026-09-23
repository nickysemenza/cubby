import { mapRecord } from "@cubby/shared";
import { z } from "zod";
import { countableEntities } from "./entity-manifest";

export const dashboardCountsOut = z.object({
  ...mapRecord(countableEntities, () => z.number().int()),
  usdaFoods: z.number().int(),
  usdaFoodsAvailable: z.boolean().optional(),
  ledgerParty: z.number().int().optional(),
  ledgerTransfer: z.number().int().optional(),
  vendorAccount: z.number().int().optional(),
  productCategory: z.number().int().optional(),
  device: z.number().int().optional(),
});

export type DashboardCountsOut = z.infer<typeof dashboardCountsOut>;
