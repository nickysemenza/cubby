import type { ActorContext } from "@cubby/schemas/context";
import { entityRefKey } from "@cubby/schemas/entity";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { parseEntityRef } from "@cubby/schemas/identifiers";
import type { ProductBulkStockTrackedInput } from "@cubby/schemas/product";
import { parseShortcode } from "@cubby/shared";

import type { Database } from "~/server/db";
import {
  type EntityKernelContext,
  entityKernelContextSchema,
  executeEntity,
  executeEntityAs,
} from "~/server/entity-kernel";
import {
  entityBrowserMutationCommandSchema,
  entityBulkUpdateCommandSchema,
  type EntityKernelEntity,
} from "~/server/entity-kernel/contracts";
import {
  lookupShortcodes,
  resolveAllOrThrow,
} from "~/server/generic/shortcode/repo/shortcode-resolver";

import { createTestRequestContext } from "./request-context";

/** The kernel context every repository method takes, acting as `actor`. */
const createTestKernelContext = (
  db: Database,
  actor: ActorContext,
): EntityKernelContext =>
  entityKernelContextSchema.parse({
    ...createTestRequestContext(db, { auth: { userId: actor.userId } }),
    actorContext: actor,
  });

/** Repository fixtures carry private ids; exercise bulk behavior at its public
 * shortcode seam while preserving deterministic audit/storage read-back. */
export const bulkUpdateFor =
  <E extends EntityKernelEntity>(entity: E) =>
  async (
    db: Database,
    ids: readonly string[],
    data: unknown,
    actor: ActorContext,
  ) => {
    const code = async (id: string) => {
      if (parseShortcode(id)) return id;
      const ref = parseEntityRef<ShortcodeEntity>(entity, id);
      const found = (await lookupShortcodes(db, [ref])).get(
        entityRefKey(entity, ref.id),
      );
      if (!found) throw new Error(`Synthetic fixture ${entity} was not found`);
      return found;
    };
    const publicIds = await Promise.all(ids.map(code));
    const result = await executeEntityAs(
      createTestKernelContext(db, actor),
      "bulkUpdate",
      entityBulkUpdateCommandSchema.parse({
        action: "bulkUpdate",
        entity,
        ids: publicIds,
        data,
      }),
    );
    const updatedShortcodes = result.updatedReferences.map((ref) => ref.id);
    return {
      updatedShortcodes,
      updatedIds: await resolveAllOrThrow(db, entity, updatedShortcodes),
    };
  };

export const bulkStockTrackedThroughKernel = async (
  db: Database,
  input: ProductBulkStockTrackedInput,
  actor: ActorContext,
) =>
  (
    await bulkUpdateFor("product")(
      db,
      input.ids,
      { stockTracked: input.stockTracked },
      actor,
    )
  ).updatedShortcodes.map((id) => ({ id }));

export const reparentThroughKernel = async (
  db: Database,
  ids: readonly string[],
  parentId: string | null,
  actor: ActorContext,
) => {
  const refs = parentId ? [parseEntityRef("location", parentId)] : [];
  const found = await lookupShortcodes(db, refs);
  const parentCode = parentId
    ? (parseShortcode(parentId)?.shortcode ??
      found.get(entityRefKey("location", parentId)))
    : null;
  return bulkUpdateFor("location")(db, ids, { parentId: parentCode }, actor);
};

/** Delete through the kernel: the declared policy inside its transaction. */
export const deleteThroughKernel = (
  db: Database,
  actor: ActorContext,
  entity: EntityKernelEntity,
  ids: readonly string[],
) =>
  executeEntity(createTestKernelContext(db, actor), {
    action: "delete",
    entity,
    ids: [...ids],
  });

/** Update through the kernel: the repository's update with its validation. */
export const updateThroughKernel = (
  db: Database,
  actor: ActorContext,
  entity: EntityKernelEntity,
  id: string,
  data: Record<string, string | number | boolean | null>,
) =>
  executeEntity(
    createTestKernelContext(db, actor),
    entityBrowserMutationCommandSchema.parse({
      action: "update",
      entity,
      id,
      data,
    }),
  );
