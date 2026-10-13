import {
  startOperationDefinitionFor,
  type StartOperationId,
} from "./start-operation-observability";

export const OPERATION_PRIORITY_HEADER = "x-cubby-operation-priority";

/** Explicit actions may promote advisory reads; unknown header values do not. */
export function operationPriority(
  operation: StartOperationId,
  headers?: Pick<Headers, "get">,
): "interactive" | "background" {
  return headers?.get(OPERATION_PRIORITY_HEADER) === "interactive" ||
    startOperationDefinitionFor(operation)?.priority !== "advisory"
    ? "interactive"
    : "background";
}
