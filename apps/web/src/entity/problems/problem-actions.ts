import { problemActionCapabilities } from "@cubby/schemas/entity-definitions/problems/problem-actions";
import type { ProblemAction } from "@cubby/schemas/entity-definitions/problems/problem-query";
import type { ComponentType } from "react";

import type { WorkActionProps } from "~/entity/work-queue/work-action-props";

type ProblemActionCapabilities = typeof problemActionCapabilities;
type ActionProps<A extends ProblemAction> = WorkActionProps<
  A["scope"] extends "item" ? "item" : "group"
>;

/**
 * What performs each declared action, shaped by the declarations above: a
 * missing, extra or renamed Problem or verb is a compile error in the table
 * `features/registry.tsx` fills, and each handler receives the target its
 * declared scope implies.
 */
export type ProblemActionHandlers = {
  readonly [K in keyof ProblemActionCapabilities]: {
    readonly [
      A in ProblemActionCapabilities[K][number] as A["id"]
    ]: ComponentType<ActionProps<A>>;
  };
};

/** The handler for a wire action id, or undefined for one this client does
 * not declare (a stale or newer server). */
export function problemActionHandler(
  handlers: ProblemActionHandlers,
  id: string,
): ComponentType<WorkActionProps> | undefined {
  const separator = id.indexOf(":");
  if (separator < 0) return undefined;
  const key = id.slice(0, separator);
  const verb = id.slice(separator + 1);
  const verbs = Object.entries(handlers).find(
    ([candidate]) => candidate === key,
  )?.[1];
  const handler = verbs
    ? Object.entries(verbs).find(([candidate]) => candidate === verb)?.[1]
    : undefined;
  // SAFETY: the server derives each action's scope from the same
  // declaration, so the wire target matches the handler's declared scope.
  return handler as ComponentType<WorkActionProps> | undefined;
}
