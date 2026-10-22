import { z } from "zod";

export const aiEvaluationJobInput = z.object({ evaluationId: z.uuid() });
