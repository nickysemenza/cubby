import { testUserId } from "@cubby/schemas/testing";

import type { Database } from "~/server/db";
import { executeEntity } from "~/server/entity-kernel";
import type {
  EntityKernelEntity,
  EntityMutationCommand,
} from "~/server/entity-kernel/contracts";
import { createTestRequestContext } from "~/server/testing/request-context";

// oxlint-disable-next-line typescript/no-explicit-any -- Test callers deliberately expose each entity's schema-inferred wire shape.
type WireValue = any;

export function withEntityKernelMutations<T extends object>(
  caller: T,
  entity: Exclude<EntityKernelEntity, "image">,
  db: Database,
) {
  const baseContext = createTestRequestContext(db, {
    auth: { userId: testUserId("test-user-id") },
  });
  if (!baseContext.actorContext) throw new Error("Test actor is required");
  const context = { ...baseContext, actorContext: baseContext.actorContext };
  const run = (command: EntityMutationCommand): Promise<WireValue> =>
    executeEntity(context, command as never) as Promise<WireValue>;

  const mutations = {
    create: async (data: WireValue) => {
      const result = await run({
        entity,
        action: "create",
        data,
      } as EntityMutationCommand);
      if (result.action !== "create") throw new Error("Wrong kernel action");
      return { ...result.item, sideEffects: result.sideEffects } as WireValue;
    },
    update: async ({ id, data }: WireValue) => {
      const result = await run({
        entity,
        action: "update",
        id,
        data,
      } as EntityMutationCommand);
      if (result.action !== "update") throw new Error("Wrong kernel action");
      return { ...result.item, sideEffects: result.sideEffects } as WireValue;
    },
    delete: async ({ ids }: WireValue) => {
      const result = await run({
        entity,
        action: "delete",
        ids,
      } as EntityMutationCommand);
      if (result.action !== "delete") throw new Error("Wrong kernel action");
      return { deleted: result.deleted, sideEffects: result.sideEffects };
    },
  };
  return new Proxy(caller, {
    get(target, property, receiver) {
      return property in mutations
        ? Reflect.get(mutations, property)
        : Reflect.get(target, property, receiver);
    },
  }) as T & typeof mutations;
}
