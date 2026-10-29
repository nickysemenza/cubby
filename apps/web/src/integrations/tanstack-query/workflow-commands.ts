import type { WorkflowCommandMetadata } from "@cubby/schemas/workflow-command";

import { OPERATIONS } from "~/lib/generated/operation-registry.gen";
import type { OperationRegistry } from "~/lib/operation-registry-types";

const registry: OperationRegistry = OPERATIONS;

/** Rendering command labels never initializes a domain's operation descriptors. */
export function workflowCommandMetadata(
  operation: string,
): WorkflowCommandMetadata {
  const command = registry[operation]?.command;
  if (!command) throw new Error(`Undeclared user command: ${operation}`);
  return command;
}

export async function loadWorkflowCommandOptions(operation: string) {
  const { workflowCommandOptions } = await import("./workflow-command-runtime");
  return workflowCommandOptions(operation);
}
