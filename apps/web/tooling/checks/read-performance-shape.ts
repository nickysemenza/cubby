import { reportSlot } from "@cubby/schemas/entity-report";
import { z } from "zod";
import type { UnparsedStartOperationData } from "~/server/operation-runtime/start-operation.contract";
import {
  entityListInputSchema,
  listEntities,
  ENTITY_LIST_READ_SCHEMAS,
} from "~/server/generated/entity-lists.server.gen";
/** Operator assertions, not inferred deployment facts. No free-form labels. */
export const workloadContextSchema = z
  .object({
    environment: z
      .enum(["local", "ci", "staging", "production"])
      .nullable()
      .default(null),
    population: z.enum(["synthetic"]).nullable().default(null),
    scale: z.number().int().min(0).max(1_000_000_000).nullable().default(null),
    cache: z.enum(["warm", "cold", "mixed"]).nullable().default(null),
    revision: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable()
      .default(null),
  })
  .strict();
const record = z.record(z.string(), z.unknown());
const entitySchema = z.enum(listEntities);

/** Selected contract metadata only; never a recursive copy or a loaded-work claim. */
export function requestedReadMetadata(
  operation: string,
  rawInput: UnparsedStartOperationData,
) {
  const parsed = record.safeParse(rawInput);
  if (!parsed.success) return null;
  const input = parsed.data;
  if (
    operation === "entityReport.get" ||
    operation === "entityReport.getMany"
  ) {
    const slots = z
      .array(reportSlot)
      .min(1)
      .max(16)
      .safeParse(operation === "entityReport.get" ? [input.slot] : input.slots);
    return slots.success
      ? {
          evidence: "partial",
          kind: "report",
          slots: slots.data,
          loadedDependencies: null,
        }
      : null;
  }
  if (operation !== "entity.list") return null;
  const entity = entitySchema.safeParse(input.entity);
  if (!entity.success) return null;
  const schema = ENTITY_LIST_READ_SCHEMAS[entity.data].schema;
  const fields = schema.shape.fields;
  const declared = [
    ...Object.keys(schema.shape).filter((key) => key !== "fields"),
    ...(fields instanceof z.ZodObject
      ? Object.keys(fields.shape).map((key) => `fields.${key}`)
      : []),
  ];
  const selected =
    input.fields === undefined
      ? null
      : z
          .array(
            z.enum(declared.map((field) => field.replace(/^fields\./, ""))),
          )
          .min(1)
          .max(500)
          .safeParse(input.fields);
  if (selected && !selected.success) return null;
  const selectedNames = selected?.success ? new Set(selected.data) : null;
  const filters = record.safeParse(input.filters ?? {});
  const contract = entityListInputSchema.options.find(
    (option) => option.shape.entity.value === entity.data,
  );
  const filterSchema = contract?.shape.filters;
  const allowed =
    filterSchema instanceof z.ZodObject ? Object.keys(filterSchema.shape) : [];
  return {
    evidence: "partial",
    kind: "list",
    entity: entity.data,
    projection: selectedNames ? "selected" : "full",
    declaredFields: selectedNames
      ? declared.filter((field) =>
          selectedNames.has(field.replace(/^fields\./, "")),
        )
      : declared,
    requestedSort: null,
    requestedGrouping: null,
    filterFields: filters.success
      ? allowed.filter((key) => Object.hasOwn(filters.data, key))
      : null,
    // Summary output and arbitrary sort/group expressions are not expanded here.
    loadedDependencies: null,
  };
}
