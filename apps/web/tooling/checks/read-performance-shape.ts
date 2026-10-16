import { reportSlot } from "@cubby/schemas/entity-report";
import { z } from "zod";
import type { UnparsedStartOperationData } from "~/server/operation-runtime/start-operation.contract";
import {
  entityListInputSchema,
  listEntities,
} from "~/entity/generated/entity-lists.gen";
import { listReadFields } from "~/entity/model/list-read-schema";
import { listEnrichmentGroups } from "~/entity/model/list-read-fields";

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
  if (
    ![
      "entity.list",
      "entity.listBase",
      "entity.listEnrichment",
      "entity.listSummary",
    ].includes(operation)
  )
    return null;
  const entity = entitySchema.safeParse(input.entity);
  if (!entity.success) return null;
  const declared = listReadFields(entity.data);
  const projection =
    operation === "entity.listBase"
      ? "base"
      : operation === "entity.listEnrichment"
        ? "enrichment"
        : operation === "entity.listSummary"
          ? "summary"
          : "full";
  const groups =
    projection === "enrichment"
      ? z.array(z.enum(listEnrichmentGroups)).max(4).safeParse(input.groups)
      : {
          success: true as const,
          data:
            projection === "base"
              ? ["core" as const]
              : projection === "summary"
                ? []
                : [
                    "core" as const,
                    ...listEnrichmentGroups.filter(
                      (group) => declared[group].length > 0,
                    ),
                  ],
        };
  if (!groups.success) return null;
  const filters = record.safeParse(input.filters ?? {});
  const contract = entityListInputSchema.options.find(
    (option) => option.shape.entity.value === entity.data,
  );
  const allowed = Object.keys(contract?.shape.filters.shape ?? {});
  return {
    evidence: "partial",
    kind: "list",
    entity: entity.data,
    projection,
    groups: groups.data,
    declaredFields:
      projection === "summary"
        ? null
        : groups.data.flatMap((group) => declared[group]),
    requestedSort: null,
    requestedGrouping: null,
    declaredGroupDependencies:
      projection === "summary" || projection === "base"
        ? null
        : Object.fromEntries(
            Object.entries(declared.dependencies).filter(([group]) =>
              groups.data.some((requested) => requested === group),
            ),
          ),
    filterFields: filters.success
      ? allowed.filter((key) => Object.hasOwn(filters.data, key))
      : null,
    // Summary output and arbitrary sort/group expressions are not expanded here.
    loadedDependencies: null,
  };
}
