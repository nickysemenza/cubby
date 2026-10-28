import type { WorkflowCommandRequest } from "@cubby/schemas/workflow-command";
import type { z } from "zod";
type WorkflowCommandResult = z.output<z.ZodUnknown>;

import { OPERATIONS } from "~/lib/generated/operation-registry.gen";
import { parseOperationInput } from "~/lib/operation-error";
import type { OperationRegistry } from "~/lib/operation-registry-types";

import type { MutationDescriptor } from "./operation-catalog";
import { workflowCommandMetadata } from "./workflow-commands";

type DomainModule = Record<
  string,
  Record<string, { definition: { kind: string } }>
>;
const domains = import.meta.glob<DomainModule>("./domains/*.ts");
const registry: OperationRegistry = OPERATIONS;

export async function workflowCommandOptions(operation: string) {
  const command = workflowCommandMetadata(operation);
  const domain = registry[operation]?.clientDomain;
  const loader = domains[`./domains/${domain}.ts`];
  if (!loader || !domain)
    throw new Error(`Undeclared user command: ${operation}`);
  const module = await loader();
  const descriptor =
    module[domain]?.[operation.slice(operation.lastIndexOf(".") + 1)];
  if (!descriptor || descriptor.definition.kind !== "mutation")
    throw new Error(`Undeclared user command: ${operation}`);
  // SAFETY: each domain exports defineOperationDomain descriptors; the registry
  // admits only mutation members explicitly declaring command metadata.
  const mutation = descriptor as MutationDescriptor<z.ZodType, z.ZodType>;
  return {
    ...mutation.mutationOptions(),
    command,
    mutationFn: async (
      body: WorkflowCommandRequest["body"],
    ): Promise<WorkflowCommandResult> =>
      mutation.call(
        parseOperationInput(operation, () =>
          mutation.definition.input.parse(body),
        ),
      ),
  };
}
