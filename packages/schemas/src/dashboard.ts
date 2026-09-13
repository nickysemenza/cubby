import { mapRecord } from "@cubby/shared";
import { z } from "zod";
import { countableEntities } from "./entity-manifest";

export const dashboardCountsOut = z.object({
  ...mapRecord(countableEntities, () => z.number().int()),
  usdaFoods: z.number().int(),
});

export type DashboardCountsOut = z.infer<typeof dashboardCountsOut>;
