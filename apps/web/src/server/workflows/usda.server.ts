import type { usdaFoodLookupInput } from "@cubby/schemas/usda";
import type { z } from "zod";

import type { USDAService } from "~/server/services/usda.service";

export const findUsdaFoodWorkflow = (
  service: USDAService,
  input: z.output<typeof usdaFoodLookupInput>,
) => service.findFood(input);
