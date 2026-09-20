import type { ReadPolicy } from "~/server/read-policy";
import {
  databaseForTransaction,
  withTransaction,
} from "~/server/repo/database-helpers";
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

  private prepared(selected: AuthenticatedRequestContext) {
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
          recipeCosting: selected.services.recipeCosting,
        },
      },
    };
  }

  async prepare(policy: ReadPolicy) {
    const selected = await selectOperationContext(this.context, policy);
    return this.prepared(selected);
  }

  async inTransaction<T>(
    run: (prepared: ReturnType<McpOperationContext["prepared"]>) => Promise<T>,
  ): Promise<T> {
    const selected = await selectOperationContext(this.context, "strong");
    return withTransaction(selected.db, async (tx) => {
      const transactionDb = databaseForTransaction(tx);
      return run(
        this.prepared({
          ...selected,
          db: transactionDb,
          readDb: transactionDb,
        }),
      );
    });
  }
}
