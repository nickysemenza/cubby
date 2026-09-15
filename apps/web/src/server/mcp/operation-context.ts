import type { ReadPolicy } from "~/server/read-policy";
import {
  selectOperationContext,
  type AuthenticatedRequestContext,
} from "~/server/request-context";

import { createMcpWorkflowCaller } from "./workflow-caller";

/**
 * Resolves the database once for one MCP tool execution. It deliberately has
 * no cache: a later tool call must observe a write made by an earlier one.
 */
export class McpOperationContext {
  constructor(private readonly context: AuthenticatedRequestContext) {}

  async prepare(policy: ReadPolicy) {
    const selected = await selectOperationContext(this.context, policy);
    return {
      caller: createMcpWorkflowCaller(selected),
      entityKernel: {
        db: selected.db,
        readDb: selected.readDb,
        actorContext: selected.actorContext,
        usdaClient: selected.usdaClient,
        usdaService: selected.usdaService,
        upcLookupClient: selected.upcLookupClient,
        services: {
          // Recipe repair and recomputation intentionally remain authoritative.
          recipeCosting: selected.services.recipeCosting,
        },
      },
    };
  }
}
