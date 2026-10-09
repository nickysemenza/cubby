import { z } from "zod";

import { entityMutation } from "~/integrations/tanstack-query/generated/entity-mutation.gen";
import type {
  EntityBrowserMutationInput,
  EntityBrowserMutationResult,
} from "~/server/entity-kernel/contracts";

import type { EditableEntity } from "./editing/types";

const unparsedEntityMutationSchema = z.unknown();
type UnparsedEntityMutation = z.input<typeof unparsedEntityMutationSchema>;

// The envelope the result is correlated against. The command itself is parsed
// once, by the server's `entity.mutate` handler against the kernel's
// per-entity schemas, so the browser never loads every entity's command union.
const mutationEnvelopeSchema = z.looseObject({
  action: z.string(),
  entity: z.string(),
});

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
  const command = mutationEnvelopeSchema.parse(input);
  // SAFETY: the server re-parses the command against
  // `entityBrowserMutationCommandSchema` before executing it.
  const result = await transport.execute(command as EntityBrowserMutationInput);
  if (
    command.entity !== entity ||
    result.action !== command.action ||
    result.entity !== entity
  ) {
    throw new Error("Entity mutation result did not match its command");
  }
  return result;
}
