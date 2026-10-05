import { z } from "zod";

/**
 * A model peer's override of the purchase agent's pinned Responses model:
 * the live coordinator eval's candidate and the live Tester Army import
 * lane's agent model both swap in through `swapResponsesModel`.
 */
export const modelSwapSchema = z.object({
  model: z.string().min(1),
  effort: z.enum(["none", "low", "medium", "high"]),
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
