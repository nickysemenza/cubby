import { auditEntitySchema } from "@cubby/schemas/audit";
import { actorInRun } from "@cubby/schemas/context";
import { runEntityId } from "@cubby/schemas/identifiers";
import type { CubbyMcpMutationAction } from "@cubby/schemas/mcp-tools";
import { purchaseImportRunExecution } from "@cubby/schemas/purchase-import";
import { parseShortcode } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { run as runTable } from "~/server/db/schema";
import { recordRunWrites } from "~/server/domains/purchase-import/repo/run-audit";
import {
  completeOperation,
  insertOperation,
  readOperation,
} from "~/server/domains/run/repo/run-operation";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import type { Principal, RunDelegation } from "~/server/http/authenticate";
import { selectOperationContext } from "~/server/http/request-context";

/**
 * Writers that enforce the purchase agent's run protocol themselves (stable
 * operation ids, replay, target checks) and so run without the
 * generic replay wrapper. Batch actions govern each item the same way.
 */
const SELF_GOVERNED_ACTIONS = new Set<string>([
  "mail.search",
  "mail.resolve",
  "purchase_import.prepare",
  "purchase_import.commit",
  "photo_run.propose_groups",
  "photo_run.commit_group",
] satisfies CubbyMcpMutationAction[]);

export const purchaseAgentSelfGoverned = (action: string) =>
  SELF_GOVERNED_ACTIONS.has(action);

const purchaseAgentArguments = z.json();
type PurchaseAgentArguments = z.infer<typeof purchaseAgentArguments>;

const collectShortcodes = (
  value: PurchaseAgentArguments,
  into = new Set<string>(),
) => {
  const text = z.string().safeParse(value);
  if (text.success) {
    if (parseShortcode(text.data)) into.add(text.data.trim().toUpperCase());
    return into;
  }
  const array = z.array(z.json()).safeParse(value);
  if (array.success) {
    for (const item of array.data) collectShortcodes(item, into);
    return into;
  }
  const object = z.record(z.string(), z.json()).safeParse(value);
  if (object.success) {
    for (const item of Object.values(object.data))
      collectShortcodes(item, into);
  }
  return into;
};

async function targetSnapshot(db: Database, args: PurchaseAgentArguments) {
  const refs = [];
  for (const code of [...collectShortcodes(args)].sort()) {
    const parsed = parseShortcode(code);
    if (!parsed) continue;
    const id = await resolveLiveShortcode(db, parsed.shortcode, parsed.type);
    refs.push({
      type: parsed.type,
      shortcode: parsed.shortcode,
      id,
    });
  }
  return refs;
}

/**
 * Run one delegated write in a single transaction under the same principal.
 * Kernel units inside it nest as savepoints. Job intents commit with the
 * writes; queue wakes and storage deletes wait for this commit
 * (`runAfterCommit`). Recipe costing is rebound to the transaction: a
 * pool-bound stale mark on a Recipe row this transaction locked would wait on
 * it forever. The transactional principal carries no budget: a deadline must
 * answer outside the transaction, never roll it back under running work.
 */
export async function inPurchaseAgentTransaction<T>(
  principal: Principal,
  run: (transactional: Principal, db: Database) => Promise<T>,
): Promise<T> {
  const selected = await selectOperationContext(principal.context, "strong");
  return withTransactionDatabase(selected.db, async (transactionDb) =>
    run(
      {
        ...principal,
        budget: null,
        context: {
          ...selected,
          db: transactionDb,
          services: {
            ...selected.services,
            recipeCosting:
              selected.services.recipeCosting.bindTo(transactionDb),
          },
        },
      },
      transactionDb,
    ),
  );
}

export async function executePurchaseAgentMutation<T>(input: {
  principal: Principal;
  delegation: RunDelegation;
  toolName: string;
  args: unknown;
  execution: z.infer<typeof purchaseImportRunExecution>;
  run: (transactional: Principal) => Promise<T>;
}): Promise<T> {
  const actor = input.principal.context.actorContext;
  const args = {
    toolName: input.toolName,
    params: purchaseAgentArguments.parse(input.args),
  };
  const argsFingerprint = await sha256Hex(JSON.stringify(args));
  const [run] = await getDb(input.principal.context.db)
    .select({
      id: runTable.id,
      actorUserId: runTable.actorUserId,
      status: runTable.status,
    })
    .from(runTable)
    .where(eq(runTable.id, runEntityId.parse(input.delegation.runId)))
    .limit(1);
  // The envelope names the run by its private id, the same value the
  // delegation token was minted for; the public code is never trusted here.
  if (
    !run ||
    run.id !== input.execution.runId ||
    run.actorUserId !== actor.userId
  )
    throw new Error(
      "Purchase-agent run execution does not match its delegation",
    );
  const operationKey = {
    runId: run.id,
    operationId: input.execution.operationId,
  };
  return inPurchaseAgentTransaction(
    input.principal,
    async (transactional, transactionDb) => {
      const database = getDb(transactionDb);
      // Serialize replay with cancellation and other attempts before any write.
      const [lockedRun] = await database
        .select({ status: runTable.status, retiredAt: runTable.retiredAt })
        .from(runTable)
        .where(eq(runTable.id, run.id))
        .limit(1)
        .for("update");
      const operation = await readOperation(database, operationKey, {
        forUpdate: true,
      });
      if (operation) {
        if (
          operation.inputFingerprint !== argsFingerprint ||
          operation.kind !== `mcp:${input.toolName}`
        )
          throw new Error("Operation id was replayed with different input");
        if (operation.state === "completed") {
          // SAFETY: the same tool, stable operation ID and exact arguments own this result.
          return operation.result as T;
        }
        throw new Error(
          operation.state === "failed"
            ? `Operation ${operationKey.operationId} failed and cannot be replayed; re-issue it under a new operation id: ${operation.error ?? "no error recorded"}`
            : "Mutation outcome is uncertain; inspect operation status",
        );
      }
      // Completed operations are read-only replays even after the Run stops.
      if (lockedRun?.retiredAt || !lockedRun || lockedRun.status !== "running")
        throw new Error(`Purchase-agent run is fenced in ${lockedRun?.status}`);
      await insertOperation(database, {
        ...operationKey,
        kind: `mcp:${input.toolName}`,
        inputFingerprint: argsFingerprint,
      });
      const result = await input.run(transactional);
      const resultArguments = purchaseAgentArguments.parse(result);
      // The tool may write rows without auditing them itself; the Run's audit
      // trail names every entity the call touched.
      const refs = await targetSnapshot(transactionDb, [args, resultArguments]);
      await recordRunWrites(
        transactionDb,
        actorInRun(actor, run.id),
        refs.flatMap((ref) => {
          const kind = auditEntitySchema.safeParse(ref.type);
          return ref.id && kind.success
            ? [
                {
                  entityKind: kind.data,
                  entityId: ref.id,
                  action: "update" as const,
                  fields: [input.toolName],
                },
              ]
            : [];
        }),
      );
      await completeOperation(database, operationKey, result);
      return result;
    },
  );
}
