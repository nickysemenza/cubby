import type { usdaFoodLookupInput } from "@cubby/schemas/usda";
import type { z } from "zod";

import type { USDAService } from "~/server/services/usda.service";
import { defineWorkflowOperation } from "~/server/workflow-runtime";

export const findUsdaFoodWorkflow = defineWorkflowOperation(
  "usda-food.alternateId",
  (service: USDAService, input: z.output<typeof usdaFoodLookupInput>) =>
    service.findFood(input),
);
