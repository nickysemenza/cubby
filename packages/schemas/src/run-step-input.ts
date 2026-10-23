import { z } from "zod";
import { shortcodeSchema } from "./identifier-fields";

export const runStepInputStepKey = z.enum([
  "transfer_pair_scan",
  "statement_generate",
  "statement_holds",
]);

const reference = z.object({
  run: shortcodeSchema("run"),
  stepKey: runStepInputStepKey,
});

const tokenParts = (value: string) => {
  const [run, stepKey, ...extra] = value.split(":");
  return extra.length === 0 ? { run, stepKey } : null;
};

/** Public list filter address; stored scope and boundaries stay on the Run. */
export const runStepInputFilterToken = z
  .string()
  .refine(
    (value) => reference.safeParse(tokenParts(value)).success,
    "Expected a Run shortcode followed by a supported input step key",
  );

export const parseRunStepInputFilterToken = (value: unknown) =>
  reference.parse(tokenParts(runStepInputFilterToken.parse(value)));

export const runStepInputInspection = z.discriminatedUnion("entity", [
  z.object({
    entity: z.literal("financialTransaction"),
    stepKey: z.enum(["transfer_pair_scan", "statement_holds"]),
  }),
  z.object({
    entity: z.literal("sourceTransactionRecord"),
    stepKey: z.enum(["transfer_pair_scan", "statement_generate"]),
  }),
]);
export type RunStepInputInspection = z.infer<typeof runStepInputInspection>;

export const supportsRunStepInputInspection = (
  entity: string,
  stepKey: string,
) => runStepInputInspection.safeParse({ entity, stepKey }).success;
