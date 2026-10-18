import { supportedChatModelSchema } from "@cubby/shared/ai/models";
import { z } from "zod";

/** Harness-only model selection; production uses the Run purpose's manifest. */
export const coordinatorModelsSchema = z.object({
  primary: supportedChatModelSchema,
  /** Absent or equal to primary leaves escalation disabled. */
  escalation: supportedChatModelSchema.optional(),
});
export type CoordinatorModels = z.infer<typeof coordinatorModelsSchema>;
