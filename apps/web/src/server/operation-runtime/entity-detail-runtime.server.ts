import { entityDetailContract } from "~/contracts/entity-detail.contract";
import { entityDetailInputSchema } from "~/entity/model/detail-contracts";
import { loadEntityDetailSchemas } from "~/entity/model/read-schemas/loaders";
import type { EntityKernelEntity } from "~/server/entity-kernel/contracts";
import { defineEntityGet } from "~/server/entity-kernel/detail-read";
import { loadEntityReadBinding } from "~/server/entity-kernel/read-binding";
import { entityActionStates } from "~/server/generic/actions/entity-action-states";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

type DetailRead = ReturnType<
  typeof defineEntityGet<
    EntityKernelEntity,
    Awaited<ReturnType<typeof loadEntityReadBinding>>["schemas"]
  >
>;
// Only declarations are retained; each invocation supplies its actor and database.
const detailReads = new Map<EntityKernelEntity, Promise<DetailRead>>();
const detailRead = (entity: EntityKernelEntity): Promise<DetailRead> => {
  let read = detailReads.get(entity);
  if (!read) {
    read = loadEntityReadBinding(entity).then(defineEntityGet);
    detailReads.set(entity, read);
  }
  return read;
};

export const entityDetailHandlers = implementOperationDomain(
  entityDetailContract,
  {
    detail: {
      // Query-default "context" policy: browser detail reads may ride the
      // bounded-stale handle; other contexts stay authoritative.
      input: entityDetailInputSchema,
      run: async (context, input) => {
        const schemas = await loadEntityDetailSchemas(input.entity);
        const result = await (
          await detailRead(input.entity)
        )(context, {
          id: input.shortcode,
          missing: "null",
        });
        return result.item === null
          ? null
          : schemas.detailOutput.parse({
              ...result.item,
              actions: entityActionStates(input.entity, result.item),
            });
      },
    },
  },
);
