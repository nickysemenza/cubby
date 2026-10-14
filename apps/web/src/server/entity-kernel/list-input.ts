import { entitySummary } from "@cubby/schemas/entity-summary";
import {
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
  for (const sort of normalized) {
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
  groupBy: string | undefined,
) => {
  if (groupBy === undefined) return undefined;
  const groupable = binding.sort.groupable ?? binding.sort.fields;
  const result = z.enum(groupable).safeParse(groupBy);
  if (!result.success)
    throw createAppError(
      "LIST_GROUP_BY_FIELD_UNSUPPORTED",
      `Unsupported groupBy field "${groupBy}" for ${binding.entity}; expected one of ${groupable.join(", ")}`,
    );
  return result.data;
};

/**
 * A list's nesting scope, `flat` when omitted. Only an entity that declares
 * `list.tree` accepts `roots`/`children`; a child scope's parent is the
 * entity's own public id.
 */
export const parseNesting = <
  E extends EntityKernelEntity,
  S extends EntityBindingSchemas,
>(
  binding: EntityKernelCoreBinding<E, S>,
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
