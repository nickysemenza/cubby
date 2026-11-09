import type { AiEvaluationTarget } from "@cubby/schemas/ai-evaluation";
import type { z } from "zod";

import type { aiEvaluation } from "~/server/db/retained-tables";
import type { DrainItem } from "~/server/generic/jobs/drain-store";

/** Pages are transient; each slot keeps its drain item and frozen evidence. */
export type EvaluationPageTarget = {
  item: DrainItem;
  evaluation: typeof aiEvaluation.$inferSelect;
  target: AiEvaluationTarget;
};

export type EvaluationPagePublication = {
  evaluationId: string;
  state: "completed" | "blocked" | "obsolete";
  receipt: z.infer<ReturnType<typeof z.json>>;
};
