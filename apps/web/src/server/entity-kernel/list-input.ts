import { generatedEntityListFields } from "@cubby/schemas/entity-list-fields";
import { entitySummary } from "@cubby/schemas/entity-summary";
import {
  type ListGroupBy,
  listGroupByDimensionsSchema,
  type ListNesting,
  listNestingSchema,
  normalizeSorts,
  type SortParams,
} from "@cubby/schemas/pagination";
import { z } from "zod";

import { createAppError } from "~/server/errors/app-error";

import type { EntityBindingSchemas, EntityKernelCoreBinding } from "./adapter";
import type { EntityKernelEntity } from "./contracts";

export const parseSchema = <S extends z.ZodType, TInput>(
  schema: S,
  input: TInput,
): z.output<S> => schema.parse(input);

export const parseSorts = <
  E extends EntityKernelEntity,
  S extends EntityBindingSchemas,
>(
  binding: EntityKernelCoreBinding<E, S>,
  value: SortParams[] | undefined,
  allowEmpty = false,
) => {
  const field = z.enum(binding.sort.fields);
  // A list search owns its opening relevance order. Preserve a caller's
  // deliberate sort, but do not synthesize the entity's ordinary opening sort
  // when the transport omitted one — otherwise relevance is unreachable.
  if (allowEmpty && value === undefined) return [];
  const normalized = normalizeSorts(
    value ?? [
      { orderBy: binding.sort.default, direction: binding.sort.direction },
    ],
  );
  const derived: Readonly<Record<string, { sort: string | null }>> =
    generatedEntityListFields[binding.entity].derived;
  for (const sort of normalized) {
    // A declared field the compiler cannot order (a to-many path, a
    // filter-only predicate) is rejected with the reason its declaration
    // derives, the same text every surface shows.
    const rejected = Object.hasOwn(derived, sort.orderBy)
      ? derived[sort.orderBy]?.sort
      : null;
    if (rejected)
      throw createAppError(
        "LIST_SORT_FIELD_UNSUPPORTED",
        `Cannot sort ${binding.entity} by "${sort.orderBy}": ${rejected}`,
      );
    const result = field.safeParse(sort.orderBy);
    if (!result.success)
      throw createAppError(
        "LIST_SORT_FIELD_UNSUPPORTED",
        `Unsupported sort field "${sort.orderBy}" for ${binding.entity}; expected one of ${binding.sort.fields.join(", ")}`,
      );
  }
  return normalized;
};

export const parseGroupBy = <
  E extends EntityKernelEntity,
  S extends EntityBindingSchemas,
>(
  binding: EntityKernelCoreBinding<E, S>,
  value: unknown,
): ListGroupBy[] => {
  const dimensions = listGroupByDimensionsSchema.optional().parse(value) ?? [];
  const choices = generatedEntityListFields[binding.entity].grouping;
  for (const dimension of dimensions) {
    const choice = choices.find(({ key }) => key === dimension.key);
    const fail = (reason: string): never => {
      throw createAppError(
        "LIST_GROUP_BY_FIELD_UNSUPPORTED",
        `Cannot group ${binding.entity} by "${dimension.key}": ${reason}`,
      );
    };
    if (choice === undefined) return fail("unknown grouping field");
    if (choice.reason !== null) fail(choice.reason);
    if (
      dimension.level !== undefined &&
      (choice.levelReason !== null || dimension.level > choice.levels)
    )
      fail(
        choice.levelReason ??
          `${choice.label} offers levels 1–${choice.levels}`,
      );
    if (
      dimension.bucket !== undefined &&
      !choice.buckets.some((bucket) => bucket === dimension.bucket)
    )
      fail(`${choice.label} does not support ${dimension.bucket} buckets`);
  }
  return dimensions;
};

/**
 * A list's nesting scope, `flat` when omitted. Only an entity that declares
 * `list.tree` accepts `roots`/`children`; a child scope's parent is the
 * entity's own public id.
 */
export const parseNesting = (
  binding: { entity: EntityKernelEntity; schemas: { id: z.ZodType } },
  value: unknown,
): ListNesting => {
  const nesting = listNestingSchema.optional().parse(value) ?? {
    scope: "flat",
  };
  if (nesting.scope === "flat") return nesting;
  const tree = Object.entries(entitySummary).find(
    ([entity]) => entity === binding.entity,
  )?.[1].list.tree;
  if (!tree)
    throw createAppError(
      "LIST_NESTING_UNSUPPORTED",
      `${binding.entity} declares no list.tree; its list nesting is flat only`,
    );
  if (nesting.scope === "children") binding.schemas.id.parse(nesting.parentId);
  return nesting;
};
