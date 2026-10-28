import {
  entityMutationAppliedFields,
  entityMutationItem,
} from "@cubby/schemas/entity-mutation";
import { shortcodeEntities } from "@cubby/schemas/entity-roster";
import { mutationSideEffectsSchema } from "@cubby/schemas/mutation-side-effects";
import { z } from "zod";

const entity = z.enum(shortcodeEntities);
const reference = z.object({ entity, id: z.string().min(1) });

/** The server validates complete receipts. Cache reconciliation reads only
 * confirmed scalar assignments and deleted identities, never expanded records. */
export const mutationReceiptSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      entity,
      item: entityMutationItem,
      appliedFields: entityMutationAppliedFields,
      sideEffects: mutationSideEffectsSchema,
    })
    .passthrough(),
  z
    .object({
      action: z.literal("update"),
      entity,
      item: entityMutationItem,
      appliedFields: entityMutationAppliedFields,
      sideEffects: mutationSideEffectsSchema,
    })
    .passthrough(),
  z
    .object({
      action: z.literal("delete"),
      entity,
      deletedReferences: z.array(reference),
      sideEffects: mutationSideEffectsSchema,
    })
    .passthrough(),
  z
    .object({
      action: z.literal("merge"),
      entity,
      item: z.looseObject({ id: z.string() }),
      mergeSummary: z.json(),
      sideEffects: mutationSideEffectsSchema,
    })
    .passthrough(),
]);
