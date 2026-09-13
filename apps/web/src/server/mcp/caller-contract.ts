import type { z } from "zod";

import { type McpWorkflowCaller, callerMethodRoster } from "./workflow-caller";

type UnparsedMcpCaller = Parameters<z.ZodType["parse"]>[0];
interface CallerPropertyOwner {}

function isObject(value: UnparsedMcpCaller): value is CallerPropertyOwner {
  return typeof value === "object" && value !== null;
}

function isCallable(
  value: UnparsedMcpCaller,
): value is (...args: never[]) => void {
  return typeof value === "function";
}

function ownDescriptor(
  value: CallerPropertyOwner,
  key: string,
): PropertyDescriptor | undefined {
  return Object.getOwnPropertyDescriptor(value, key);
}

export function isMcpWorkflowCaller(
  candidate: UnparsedMcpCaller,
): candidate is McpWorkflowCaller {
  if (!isObject(candidate)) return false;
  for (const [domain, methods] of Object.entries(callerMethodRoster)) {
    const group = ownDescriptor(candidate, domain)?.value;
    if (!isObject(group)) return false;
    for (const method of Object.keys(methods)) {
      if (!isCallable(ownDescriptor(group, method)?.value)) return false;
    }
  }
  return true;
}

/** Parse the in-process caller carried through the SDK's untyped authInfo bag. */
export function parseMcpWorkflowCaller(
  candidate: UnparsedMcpCaller,
): McpWorkflowCaller {
  if (!isMcpWorkflowCaller(candidate)) {
    throw new Error("Authenticated workflow caller is missing or incomplete");
  }
  return candidate;
}
