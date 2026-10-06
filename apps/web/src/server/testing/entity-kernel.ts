import type { ActorContext } from "@cubby/schemas/context";

import type { Database } from "~/server/db";
import {
  type EntityKernelContext,
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import {
  entityBrowserMutationCommandSchema,
  type EntityKernelEntity,
} from "~/server/entity-kernel/contracts";

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
