import {
  type EntityKernelContext,
  entityKernelContextSchema,
} from "~/server/entity-kernel";

import type { ToolExtra } from "./tools/tool-registration";

/** The MCP request's explicit entity-kernel capability; other tools read `getRequestContext`. */
export function getEntityKernelContext(extra: ToolExtra): EntityKernelContext {
  const context = extra.authInfo?.extra?.entityKernel;
  if (!context)
    throw new Error("Authenticated entity-kernel context is missing");
  return entityKernelContextSchema.parse(context);
}
