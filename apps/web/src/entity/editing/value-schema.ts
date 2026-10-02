import { z } from "zod";

/** Browser-local draft values may retain Dates until their intent serializes them. */
const entityEditValueSchema = z.union([z.json(), z.date(), z.undefined()]);
export const entityEditValueBagSchema = z.record(
  z.string(),
  entityEditValueSchema,
);

export type EntityEditValue = z.infer<typeof entityEditValueSchema>;
export type EntityEditValueBag = z.infer<typeof entityEditValueBagSchema>;

type JsonValue = z.infer<ReturnType<typeof z.json>>;

/**
 * `z.json()` with every nested `Date` projected to its ISO string, so a read
 * projection whose rows carry audit timestamps (`unitMappingOut`/
 * `externalIdOut` `createdAt`/`updatedAt`) fits the value bag's JSON branch.
 */
const projectedJsonSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.date().transform((date) => date.toISOString()),
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(projectedJsonSchema),
    z.record(z.string(), projectedJsonSchema),
  ]),
);

/**
 * The tolerant read of one record value into the editor's value bag. A record
 * is a full read projection and may hold shapes the bag never accepts
 * (nested `Date`s, class instances); opening an editor must never throw on
 * one. The value is projected (nested dates → ISO strings) when that makes it
 * fit, and ignored (`undefined`, "no baseline") otherwise. This only widens
 * what a *record* seeds — what the form may *submit* is still
 * `entityEditValueBagSchema.parse` in the kernel.
 */
export function projectEntityEditRecordValue(value: unknown): EntityEditValue {
  const direct = entityEditValueSchema.safeParse(value);
  if (direct.success) return direct.data;
  const projected = projectedJsonSchema.safeParse(value);
  return projected.success ? projected.data : undefined;
}
