import {
  type EntityKernelContext,
  entityKernelContextSchema,
} from "~/server/entity-kernel";

type ToolExtra = { authInfo?: { extra?: Record<string, unknown> } };

/** The MCP request's explicit entity-kernel capability; workflow tools use caller instead. */
export function getEntityKernelContext(extra: ToolExtra): EntityKernelContext {
  const context = extra.authInfo?.extra?.entityKernel;
  if (!context)
    throw new Error("Authenticated entity-kernel context is missing");
  return entityKernelContextSchema.parse(context);
}
