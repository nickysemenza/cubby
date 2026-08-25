import { mutationOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import type {
  EntityMutationCommand,
  EntityMutationResult,
} from "~/server/entity-kernel/contracts";
import {
  observedEntityCall,
  type PublicEntityError,
  unwrapEntityTransportResult,
} from "./entity-transport";

// biome-ignore lint/suspicious/noExplicitAny: the kernel's entity-specific item union is validated before crossing the Start serialization seam
type MutationWireData = any;

type MutationTransportResult =
  | { ok: true; data: MutationWireData }
  | { ok: false; error: PublicEntityError };

const executeEntityMutationTransport = createServerFn({ method: "POST" })
  .validator(z.unknown())
  .handler(async ({ data }): Promise<MutationTransportResult> => {
    const [transportModule, kernelModule, contractModule] = await Promise.all([
      import("~/server/entity-read-transport"),
      import("~/server/entity-kernel"),
      import("~/server/entity-kernel/contracts"),
    ]);
    return await transportModule.runEntityMutationTransport({
      operation: "entity.mutate",
      input: data,
      headers: getRequest().headers,
      execute: async (context) => {
        const command = contractModule.entityMutationCommandSchema.parse(data);
        return contractModule.entityMutationResultSchema.parse(
          await kernelModule.executeEntity(context, command),
        );
      },
    });
  });

async function executeEntityMutation(options: {
  data: EntityMutationCommand;
  signal?: AbortSignal;
}): Promise<EntityMutationResult> {
  return await observedEntityCall("entity.mutate", options.data, async () =>
    unwrapEntityTransportResult(
      "entity.mutate",
      (await executeEntityMutationTransport(
        options,
      )) as import("./entity-transport").EntityTransportResult<EntityMutationResult>,
    ),
  );
}

export function entityMutationOptions() {
  return mutationOptions({
    mutationKey: [["entity", "mutate"]] as const,
    mutationFn: (command: EntityMutationCommand) =>
      executeEntityMutation({ data: command }),
  });
}
