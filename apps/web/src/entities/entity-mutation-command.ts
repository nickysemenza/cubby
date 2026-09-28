import { z } from "zod";

import { entityMutation } from "~/integrations/tanstack-query/generated/catalog.gen";
import {
  entityBrowserMutationCommandSchema,
  type EntityBrowserMutationInput,
  type EntityBrowserMutationResult,
} from "~/server/entity-kernel/contracts";

import type { EditableEntity } from "./editing/types";

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
export async function executeEntityMutationCommand<E extends EditableEntity>(
  entity: E,
  input: UnparsedEntityMutation,
  transport: EntityMutationTransport = startEntityMutationTransport,
): Promise<EntityBrowserMutationResult> {
  const command = entityBrowserMutationCommandSchema.parse(input);
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
