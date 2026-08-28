import { testUserId } from "@cubby/schemas/testing";

import type { Database } from "~/server/db";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityMutationCommand } from "~/server/entity-kernel/contracts";
import { createTestRequestContext } from "~/server/testing/request-context";

type RecipeCreateCommand = Extract<
  EntityMutationCommand,
  { action: "create"; entity: "recipe" }
>;
type RecipeUpdateCommand = Extract<
  EntityMutationCommand,
  { action: "update"; entity: "recipe" }
>;

/**
 * The one integration caller that needs recipe creation through the entity
 * kernel. Keeping the command concrete preserves its generated recipe input
 * and result correlation without a proxy, reflective lookup, or erased wire
 * value.
 */
export function createRecipeKernelTestCaller(db: Database) {
  const baseContext = createTestRequestContext(db, {
    auth: { userId: testUserId("test-user-id") },
  });
  if (!baseContext.actorContext) throw new Error("Test actor is required");
  const context = { ...baseContext, actorContext: baseContext.actorContext };

  return {
    create: async (data: RecipeCreateCommand["data"]) => {
      const command = {
        entity: "recipe",
        action: "create",
        data,
      } satisfies RecipeCreateCommand;
      const result = await executeEntity(context, command);
      return { ...result.item, sideEffects: result.sideEffects };
    },
    update: async ({ id, data }: Pick<RecipeUpdateCommand, "id" | "data">) => {
      const command = {
        entity: "recipe",
        action: "update",
        id,
        data,
      } satisfies RecipeUpdateCommand;
      const result = await executeEntity(context, command);
      return { ...result.item, sideEffects: result.sideEffects };
    },
  };
}
