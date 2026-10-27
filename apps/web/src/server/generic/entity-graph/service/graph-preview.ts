import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type {
  EntityGraphOutput,
  EntityGraphNode,
} from "@cubby/schemas/entity-graph";
import { entityGraphNodeSchema } from "@cubby/schemas/entity-graph";
import { entityPreviewFieldKeys } from "@cubby/schemas/entity-preview";
import { entitySummary } from "@cubby/schemas/entity-summary";

import { listEntities } from "~/entity/generated/entity-lists.gen";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { ENTITY_LIST_READ_OPERATIONS } from "~/server/generated/entity-list-read-bindings.gen";
import { listReadSchema } from "~/server/generic/list/repo/list-read-schema";

/** Reuse the canonical selected-field readers for money, quantities, enums, and progress. */
export async function withGraphPreviews<
  T extends Pick<EntityGraphOutput, "nodes">,
>(context: EntityKernelContext, graph: T): Promise<T> {
  const previews = new Map<string, NonNullable<EntityGraphNode["preview"]>>();
  await Promise.all(
    listEntities.map(async (entity) => {
      const nodes = graph.nodes.filter((node) => node.entityKind === entity);
      if (!nodes.length) return;
      const presentation = entitySummary[entity].detail;
      const roster = [
        ...entityPreviewFieldKeys(entity),
        ...(presentation.hero.chip ? [presentation.hero.chip] : []),
      ];
      const fields = entityFieldModels[entity].fields;
      const allowed = new Set(Object.keys(listReadSchema(entity).shape));
      const keys = [
        ...new Set(
          roster.flatMap((key) => {
            const field = fields.find((item) => item.key === key);
            const path = field?.display.readPath?.split(/[.[]/u)[0];
            return field?.readKey ? [field.readKey] : path ? [path] : [];
          }),
        ),
      ]
        .filter((key) => allowed.has(key))
        .slice(0, 12);
      if (!keys.length) return;
      const result = await ENTITY_LIST_READ_OPERATIONS[entity].listFields(
        context,
        {
          filters: { ids: nodes.map((node) => node.entityId) },
          pagination: { pageIndex: 0, pageSize: nodes.length },
        },
        keys,
      );
      for (const row of result.items) {
        // Match the list transport's Date and absent-property serialization.
        const preview = entityGraphNodeSchema.shape.preview
          .unwrap()
          .parse(JSON.parse(JSON.stringify(row)));
        previews.set(`${entity}:${row.id}`, preview);
      }
    }),
  );
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      preview: previews.get(`${node.entityKind}:${node.entityId}`),
    })),
  };
}
