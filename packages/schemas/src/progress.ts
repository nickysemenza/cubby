import { z } from "zod";

const count = z.number().int().nonnegative();

/** The state a labelled part of a small population draws in. */
const progressPartStates = ["done", "active", "failed", "queued"] as const;

/**
 * How far a piece of work has come, as counts of `unit`. Every client draws it
 * from these counts alone: a total of 12 or fewer as segments (labelled when
 * `parts` names them), a larger one as a proportional bar, and a `null` total
 * as an indeterminate track. `stalled` counts items that stopped advancing and
 * are not otherwise failed.
 */
export const progressValueSchema = z
  .object({
    done: count,
    failed: count,
    active: count,
    stalled: count,
    queued: count,
    total: count.nullable(),
    /** The plural noun one counted item is (`orders`, `photos`). */
    unit: z.string().min(1),
    parts: z
      .array(
        z.object({
          label: z.string().min(1),
          state: z.enum(progressPartStates),
        }),
      )
      .optional(),
  })
  .meta({ id: "ProgressValue" });
export type ProgressValue = z.infer<typeof progressValueSchema>;
