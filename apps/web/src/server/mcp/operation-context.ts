import { deferPublications } from "~/server/background-tasks/publish";
import type { ReadPolicy } from "~/server/read-policy";
import { withTransactionDatabase } from "~/server/repo/database-helpers";
import {
  selectOperationContext,
  type AuthenticatedRequestContext,
} from "~/server/request-context";

/**
 * Resolves the database once for one MCP tool execution. It deliberately has
 * no cache: a later tool call must observe a write made by an earlier one.
 */
export class McpOperationContext {
  constructor(private readonly context: AuthenticatedRequestContext) {}

  private prepared(selected: AuthenticatedRequestContext) {
    return {
      requestContext: selected,
      entityKernel: {
        db: selected.db,
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

  /**
   * Run one tool call in a single transaction. Kernel units inside it nest as
   * savepoints, and their publications and storage deletes wait for this
   * commit (`runAfterCommit`). Recipe costing is rebound to the transaction:
   * a pool-bound stale mark on a Recipe row this transaction locked would
   * wait on it forever.
   */
  async inTransaction<T>(
    run: (prepared: ReturnType<McpOperationContext["prepared"]>) => Promise<T>,
  ): Promise<T> {
    const selected = await selectOperationContext(this.context, "strong");
    const deferred = deferPublications();
    const result = await withTransactionDatabase(
      selected.db,
      async (transactionDb) =>
        run(
          this.prepared({
            ...selected,
            db: transactionDb,
            services: {
              ...selected.services,
              recipeCosting: selected.services.recipeCosting.bindTo(
                transactionDb,
                deferred.publish,
              ),
            },
          }),
        ),
    );
    await deferred.flush(selected.db);
    return result;
  }
}
