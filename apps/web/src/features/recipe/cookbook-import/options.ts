import type { ExtractOptions } from "@cubby/recipebridge/cookbook";

/** Estimate and extraction share the deployment's quality-first model order. */
export const extractOptions = (label: string): ExtractOptions => ({
  label,
  concurrency: 8,
  ladder: ["claude-sonnet-5", "claude-haiku-4-5", "gpt-6-luna"],
  second_opinion: true,
  whole_book_escalation: true,
  max_output_tokens: 16000,
});
