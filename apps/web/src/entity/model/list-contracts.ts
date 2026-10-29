import type { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import {
  listNestingSchema,
  listResultMembership,
  listGroupByDimensionsSchema,
  MAX_PAGE_SIZE,
  MAX_SORTS,
} from "@cubby/schemas/pagination";
import type { buildPaginatedResponse } from "@cubby/schemas/pagination";
import { z } from "zod";
export type EntityListResultByEntity = {
  [E in ListEntity]: ReturnType<
    typeof buildPaginatedResponse<
      z.output<(typeof entityFieldEnvelopeSchemas)[E]["list"]>
    >
  >;
};
export type SelectedListItem<T extends { id: string; fields: object }> =
  Partial<Omit<T, "id" | "fields">> &
    Pick<T, "id"> & { fields: Partial<T["fields"]> };
export type EntitySelectedListResultByEntity = {
  [E in ListEntity]: {
    items: SelectedListItem<
      z.output<(typeof entityFieldEnvelopeSchemas)[E]["list"]>
    >[];
    meta: EntityListResultByEntity[E]["meta"];
    selectedFields: string[];
  };
};
import { listEntities } from "../generated/entity-read-keys.gen";
export type ListEntity = (typeof listEntities)[number];
const filterValue = z
  .union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])
  .optional();
/** Plan fields shared by the roster input and each entity's strict read input. */
export const listReadPlan = {
  sort: z
    .array(
      z.object({
        orderBy: z.string().min(1),
        direction: z.enum(["asc", "desc"]),
      }),
    )
    .min(1)
    .max(MAX_SORTS)
    .optional(),
  pagination: z
    .object({
      pageIndex: z.number().int().min(0),
      pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE),
    })
    .optional(),
  groupBy: listGroupByDimensionsSchema.optional(),
  resultMembership: listResultMembership.optional(),
  includeCount: z.boolean().optional(),
};
const entityListPlan = z.object({
  filters: z.record(z.string(), filterValue),
  ...listReadPlan,
  nesting: listNestingSchema.optional(),
  fields: z
    .array(z.string().min(1))
    .min(1)
    .max(500)
    .transform((fields) => [...new Set(fields)].sort())
    .optional(),
});
const rawEntityListInputSchema = entityListPlan.extend({
  entity: z.enum(listEntities),
});
type Plan = z.input<typeof rawEntityListInputSchema>;
export type EntityListInputByEntity = {
  [E in ListEntity]: Omit<Plan, "entity"> & { entity: E };
};
export type ParsedEntityListInputByEntity = {
  [E in ListEntity]: Omit<
    z.output<typeof rawEntityListInputSchema>,
    "entity"
  > & {
    entity: E;
  };
};
export type EntityListParamsByEntity = {
  [E in ListEntity]: Omit<EntityListInputByEntity[E], "entity">;
};
export type EntityListParseInput = Omit<Plan, "entity" | "filters"> & {
  entity: ListEntity;
  filters: z.input<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
};
export function entityListInputFor<E extends ListEntity>(
  entity: E,
  input: EntityListParamsByEntity[E],
): EntityListInputByEntity[E];
export function entityListInputFor(
  entity: ListEntity,
  input: EntityListParamsByEntity[ListEntity],
) {
  return { entity, ...input };
}
export function entityListParamsFromParsed<E extends ListEntity>(
  entity: E,
  input: ParsedEntityListInputByEntity[E],
): EntityListParamsByEntity[E];
export function entityListParamsFromParsed(
  entity: ListEntity,
  input: ParsedEntityListInputByEntity[ListEntity],
) {
  if (input.entity !== entity)
    throw new Error("Entity list input discriminator mismatch");
  const { entity: _entity, ...params } = input;
  return params;
}
// Entity-specific filters are validated by the selected server read owner.
export function parseEntityListInput<E extends ListEntity>(
  entity: E,
  value: EntityListInputByEntity[E] | EntityListParseInput,
): ParsedEntityListInputByEntity[E];
export function parseEntityListInput(
  entity: ListEntity,
  value: EntityListParseInput,
) {
  const parsed = entityListInputSchema.parse(value);
  if (parsed.entity !== entity)
    throw new Error("Entity list input discriminator mismatch");
  return parsed;
}

// SAFETY: each accepted enum value selects the same plan shape. This exposes
// the key correlation that z.object with an enum cannot express on its own.
export const entityListInputSchema = rawEntityListInputSchema as z.ZodType<
  ParsedEntityListInputByEntity[ListEntity],
  EntityListInputByEntity[ListEntity]
>;
