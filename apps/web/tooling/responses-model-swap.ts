import {
  openAiChatModelSchema,
  openAiEffortSchema,
} from "@cubby/shared/ai/models";
import { z } from "zod";

/**
 * A model peer's override of the purchase agent's pinned Responses model:
 * the live coordinator eval's candidate and the live Tester Army import
 * lane's agent model both swap in through `swapResponsesModel`. The peers
 * rewrite OpenAI Responses bodies only, so a model reached over another
 * protocol is refused rather than sent upstream on the wrong one.
 */
export const modelSwapSchema = z.object({
  model: z.enum(openAiChatModelSchema.options, {
    error: (issue) =>
      `The model peer speaks only OpenAI Responses; ${String(issue.input)} is not a declared OpenAI chat model`,
  }),
  effort: openAiEffortSchema,
});
export type ModelSwap = z.infer<typeof modelSwapSchema>;

const requestBody = z.looseObject({
  reasoning: z.looseObject({}).optional(),
});

/** The Responses request body with the swapped model and reasoning effort; every other setting is kept. */
export function swapResponsesModel(body: unknown, swap: ModelSwap) {
  const parsed = requestBody.parse(body);
  return {
    ...parsed,
    model: swap.model,
    reasoning: { ...parsed.reasoning, effort: swap.effort },
  };
}
