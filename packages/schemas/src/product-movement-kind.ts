import { z } from "zod";

export const productMovementKind = z.enum([
  "linked",
  "acquired",
  "exited",
  "discarded",
  // Money came back and no unit moved: a price concession with the item kept.
  // Distinct from "exited" because the timeline draws ownership from these —
  // reading a concession as an exit would end an ownership span the household
  // never ended.
  "adjusted",
  "unknown",
]);
export type ProductMovementKind = z.infer<typeof productMovementKind>;
