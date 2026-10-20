import { z } from "zod";

import { entitySchema } from "./entity-core";

/** A report names its whole input scope; no saved Collection is required. */
export const reportScope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("record"), id: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("list"),
    entity: entitySchema,
    // The chosen report validates its supported filters before reading data.
    filters: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    kind: z.literal("selection"),
    entity: entitySchema,
    ids: z.array(z.string().min(1)).min(1).max(1000),
  }),
]);
