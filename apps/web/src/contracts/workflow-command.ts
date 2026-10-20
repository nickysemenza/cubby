import type { ReportCommandRequest } from "@cubby/schemas/entity-report";
import { workflowCommandRequest } from "@cubby/schemas/workflow-command";
import type { z } from "zod";

import type { MutationContract, OperationContract } from "./define";

type Template<T> = T extends readonly (infer Item)[]
  ? Template<Item>[]
  : T extends object
    ? { [K in keyof T]: Template<T[K]> }
    : T | null;
type MutationName<C extends OperationContract> = {
  [K in keyof C["ops"]]: C["ops"][K] extends MutationContract ? K : never;
}[keyof C["ops"]] &
  string;

/** The existing operation validates the completed body; construction pins its exact field names. */
export function operationCommandRequest<
  C extends OperationContract,
  K extends MutationName<C>,
>(
  contract: C,
  member: K,
  body: Template<z.input<C["ops"][K]["input"]>>,
  bindings?: Record<string, string>,
): Extract<ReportCommandRequest, { kind: "operation" }> {
  const definition = contract.ops[member];
  if (definition?.kind !== "mutation" || !definition.command)
    throw new Error(
      `${contract.domain}.${member} is not a declared user command`,
    );
  return workflowCommandRequest.parse({
    kind: "operation",
    operation: `${contract.domain}.${member}`,
    body,
    bindings,
  });
}
