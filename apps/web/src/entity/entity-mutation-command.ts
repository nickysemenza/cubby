import type { Entity } from "@cubby/schemas/entity";
import { createIsomorphicFn, createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { entityMutation } from "~/integrations/tanstack-query/domains/entityMutation";
import type {
  EntityBrowserMutationInput,
  EntityBrowserMutationResult,
} from "~/server/entity-kernel/contracts";

// Canonical bulk schemas validate reflected collection keys whose static type is erased.
const validateMutationOnServer = createServerFn({
  method: "POST",
  strict: { output: false },
})
  .validator(z.unknown())
  .handler(async ({ data }) => {
    const { entityBrowserMutationCommandSchema } =
      await import("~/server/entity-kernel/contracts");
    return entityBrowserMutationCommandSchema.parse(data);
  });

const parseMutation = createIsomorphicFn()
  .server(async (input: UnparsedEntityMutation) => {
    const { entityBrowserMutationCommandSchema } =
      await import("~/server/entity-kernel/contracts");
    return entityBrowserMutationCommandSchema.parse(input);
  })
  .client((input: UnparsedEntityMutation) =>
    validateMutationOnServer({ data: input }),
  );

const unparsedEntityMutationSchema = z.unknown();
type UnparsedEntityMutation = z.input<typeof unparsedEntityMutationSchema>;

export interface EntityMutationTransport {
  execute(
    command: EntityBrowserMutationInput,
  ): Promise<EntityBrowserMutationResult>;
}

const startEntityMutationTransport: EntityMutationTransport = {
  execute: (command) =>
    entityMutation.mutate.forEntity(command.entity).call(command),
};

/** Parse, execute, and correlate one standard browser mutation. */
export async function executeEntityMutationCommand<E extends Entity>(
  entity: E,
  input: UnparsedEntityMutation,
  transport: EntityMutationTransport = startEntityMutationTransport,
): Promise<EntityBrowserMutationResult> {
  const command = await parseMutation(input);
  if (command.entity !== entity)
    throw new Error(
      "Entity mutation command did not match its requested entity",
    );
  const result = await transport.execute(command);
  if (
    command.entity !== entity ||
    result.action !== command.action ||
    result.entity !== entity
  ) {
    throw new Error("Entity mutation result did not match its command");
  }
  return result;
}
