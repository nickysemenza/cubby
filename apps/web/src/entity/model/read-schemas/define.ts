import { entityActionStates } from "@cubby/schemas/action-availability";
import { shortcodeSchema } from "@cubby/schemas/identifiers";
import {
  listChildCountSchema,
  listNestingSchema,
  paginatedMetaSchema,
} from "@cubby/schemas/pagination";
import type { ShortcodeType as ShortcodeEntity } from "@cubby/shared";
import { z } from "zod";

import {
  listReadPlan,
  type SelectedListItem,
} from "~/entity/model/list-contracts";
import { compileListReadSchema } from "~/entity/model/list-read-fields";

type Definition = {
  entity: ShortcodeEntity;
  envelopes: {
    list: z.ZodObject<{ id: z.ZodType<string>; fields: z.ZodObject }>;
    detail: z.ZodObject;
  };
  filterFields: z.ZodRawShape | null;
  searchable: boolean;
  tree: boolean;
};

function listItemFor<const D extends Definition>(definition: D) {
  const item = definition.tree
    ? definition.envelopes.list.extend({ childCount: listChildCountSchema })
    : definition.envelopes.list;
  // SAFETY: the only extension is childCount on a tree definition. Keep the
  // concrete envelope's fields correlated with its generated entity key.
  return item as D["tree"] extends true
    ? z.ZodObject<
        D["envelopes"]["list"]["shape"] & {
          childCount: typeof listChildCountSchema;
        }
      >
    : D["envelopes"]["list"];
}

/** One owner for schema composition, shared by eager native naming and lazy reads. */
function buildEntityReadContracts<const D extends Definition>(definition: D) {
  const { entity, envelopes, filterFields, searchable, tree } = definition;
  const filters =
    filterFields === null
      ? z.record(z.string(), z.unknown())
      : z.strictObject({
          ...filterFields,
          ...(searchable
            ? { searchQuery: z.string().trim().min(1).max(100).optional() }
            : {}),
          ids: z.array(z.string()).max(500).optional(),
        });
  const listItem = listItemFor(definition);
  // `entity.detail` and `entity.list` rows carry the server's action availability.
  // SAFETY: `extend` adds exactly `actions` to the definition's detail envelope.
  const detailOutput = envelopes.detail.extend({
    actions: entityActionStates,
  }) as WithActions<D["envelopes"]["detail"]>;
  const listInputBase = z.object({
    entity: z.literal(entity),
    filters,
    ...listReadPlan,
  });
  const listInput = tree
    ? listInputBase.extend({ nesting: listNestingSchema.optional() })
    : listInputBase;
  const listOutput: z.ZodObject = z.object({
    items: z.array(listItem.extend({ actions: entityActionStates })),
    meta: paginatedMetaSchema,
  });
  const selectedListOutput: z.ZodType = z.object({
    items: z.array(
      listItem.partial().extend({
        id: listItem.shape.id,
        fields: listItem.shape.fields.partial(),
        actions: entityActionStates,
      }),
    ),
    meta: paginatedMetaSchema,
    selectedFields: z.array(z.string()),
  });
  return {
    detailInput: z.object({
      entity: z.literal(entity),
      shortcode: shortcodeSchema(entity),
    }),
    detailOutput: detailOutput,
    listInput,
    listItem,
    // SAFETY: rows also carry `actions` (read through `serverActionState`);
    // the type keeps the entity's own row so the read unions stay comparable.
    listOutput: listOutput as z.ZodObject<{
      items: z.ZodArray<typeof listItem>;
      meta: typeof paginatedMetaSchema;
    }>,
    // SAFETY: the schema preserves id and partial envelope fields.
    selectedListOutput: selectedListOutput as z.ZodType<SelectedListOutput<D>>,
    listRead: compileListReadSchema(listItem),
  };
}

type WithActions<S extends z.ZodObject> = z.ZodObject<
  S["shape"] & { actions: typeof entityActionStates }
>;

type SelectedListOutput<D extends Definition> = {
  // Rows also carry `actions` (read through `serverActionState`); the type
  // leaves it out so the selected and full list unions stay comparable.
  items: SelectedListItem<z.output<D["envelopes"]["list"]>>[];
  meta: z.output<typeof paginatedMetaSchema>;
  selectedFields: string[];
};

type EntityReadContracts<D extends Definition> = ReturnType<
  typeof buildEntityReadContracts<D>
>;
const contracts = new WeakMap<Definition, EntityReadContracts<Definition>>();
export function defineEntityReadContracts<const D extends Definition>(
  definition: D,
): EntityReadContracts<D> {
  let result = contracts.get(definition);
  if (!result) {
    result = buildEntityReadContracts(definition);
    contracts.set(definition, result);
  }
  // SAFETY: this WeakMap is keyed by the exact definition object used to build
  // the schemas; the generic parameter is erased only while storing it.
  return result as EntityReadContracts<D>;
}
