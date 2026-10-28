import { z } from "zod";

import { plainDate } from "./base-entity";
import { runShortcode, vendorShortcode } from "./identifier-fields";

export const controlledMailDateRange = z.strictObject({
  from: plainDate.optional(),
  to: plainDate.optional(),
});

export const controlledMailImportInput = controlledMailDateRange
  .extend({ mailboxId: z.string().min(1), vendorId: vendorShortcode })
  .refine((input) => !input.from || !input.to || input.from <= input.to, {
    message: "The start date must be on or before the end date.",
    path: ["to"],
  });
export type ControlledMailImportInput = z.infer<
  typeof controlledMailImportInput
>;

export const controlledMailImportOutput = z.object({
  run: runShortcode,
  state: z.enum(["queued", "running"]),
});
export type ControlledMailImportOutput = z.infer<
  typeof controlledMailImportOutput
>;
