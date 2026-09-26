import { auditEntitySchema } from "@cubby/schemas/audit";
import type { ActorContext } from "@cubby/schemas/context";
import { runEntityId } from "@cubby/schemas/identifiers";
import { purchaseImportRunExecution } from "@cubby/schemas/purchase-import";
import { parseShortcode } from "@cubby/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  auditLog,
  run as runTable,
  runApproval,
  runMutation,
  runOperation,
} from "~/server/db/schema";
import type { McpOperationContext } from "~/server/mcp/operation-context";
import { getDb } from "~/server/repo/database-helpers";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

import type { ToolExtra } from "./tools/tool-registration";

const purchaseAgentRunExecutionEnvelope = z.object({
  _runExecution: purchaseImportRunExecution.optional(),
});

export function decoratePurchaseAgentInputSchema<T extends z.ZodObject>(
  schema: T,
) {
  return "_runExecution" in schema.shape
    ? schema
    : schema.extend(purchaseAgentRunExecutionEnvelope.shape);
}

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

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
    const auditable = auditEntitySchema.safeParse(parsed.type);
    const [latest] =
      id && auditable.success
        ? await getDb(db)
            .select({ id: auditLog.id, createdAt: auditLog.createdAt })
            .from(auditLog)
            .where(
              and(
                eq(auditLog.entityType, auditable.data),
                eq(auditLog.entityId, id),
              ),
            )
            .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
            .limit(1)
        : [];
    refs.push({
      type: parsed.type,
      shortcode: parsed.shortcode,
      id,
      latestAuditId: latest?.id ?? null,
      latestAuditAt: latest?.createdAt.toISOString() ?? null,
    });
  }
  return refs;
}

export async function purchaseAgentTargetFingerprint(
  db: Database,
  args: PurchaseAgentArguments,
) {
  return sha256(JSON.stringify(await targetSnapshot(db, args)));
}

type TrustedPurchaseAgent = { runId: string; grantId: string };

export function trustedPurchaseAgent(
  extra: ToolExtra,
): TrustedPurchaseAgent | null {
  const parsed = z
    .object({ runId: z.uuid(), grantId: z.string().min(1) })
    .safeParse(extra.authInfo?.extra?.purchaseAgent);
  return parsed.success ? parsed.data : null;
}

export async function executePurchaseAgentMutation<T>(input: {
  db: Database;
  actor: ActorContext;
  operationContext: McpOperationContext;
  trusted: TrustedPurchaseAgent;
  toolName: string;
  args: unknown;
  execution: z.infer<typeof purchaseImportRunExecution>;
  run: (preparedExtra: ToolExtra) => Promise<T>;
  baseExtra: ToolExtra;
}): Promise<T> {
  const args = {
    toolName: input.toolName,
    params: purchaseAgentArguments.parse(input.args),
  };
  const argsFingerprint = await sha256(JSON.stringify(args));
  const evidenceFingerprint = argsFingerprint;
  const [run] = await getDb(input.db)
    .select({
      id: runTable.id,
      actorUserId: runTable.actorUserId,
      status: runTable.status,
    })
    .from(runTable)
    .where(eq(runTable.id, runEntityId.parse(input.trusted.runId)))
    .limit(1);
  // The envelope names the run by its private id, the same value the
  // delegation token was minted for; the public code is never trusted here.
  if (
    !run ||
    run.id !== input.execution.runId ||
    run.actorUserId !== input.actor.userId
  )
    throw new Error(
      "Purchase-agent run execution does not match its delegation",
    );
  const targetFingerprint = await purchaseAgentTargetFingerprint(
    input.db,
    args,
  );
  const [operation] = await getDb(input.db)
    .select({
      state: runOperation.state,
      inputFingerprint: runOperation.inputFingerprint,
      result: runOperation.result,
    })
    .from(runOperation)
    .where(
      and(
        eq(runOperation.runId, run.id),
        eq(runOperation.operationId, input.execution.operationId),
      ),
    )
    .limit(1);
  if (!operation) {
    if (run.status !== "running" && run.status !== "paused_approval")
      throw new Error(`Purchase-agent run is fenced in ${run.status}`);
    await getDb(input.db).transaction(async (tx) => {
      await tx.insert(runOperation).values({
        runId: run.id,
        operationId: input.execution.operationId,
        kind: `mcp:${input.toolName}`,
        inputFingerprint: argsFingerprint,
        state: "paused_approval",
        result: {
          approvalProposal: {
            operationKind: `mcp:${input.toolName}`,
            args,
            targetFingerprint,
            evidenceFingerprint,
          },
        },
      });
      await tx.insert(runApproval).values({
        runId: run.id,
        operationId: input.execution.operationId,
        operationKind: `mcp:${input.toolName}`,
        args,
        argsFingerprint,
        targetFingerprint,
        evidenceFingerprint,
        state: "pending",
      });
      await tx
        .update(runTable)
        .set({ status: "paused_approval", updatedAt: new Date() })
        .where(eq(runTable.id, run.id));
    });
    throw new Error(
      "Purchase-agent mutation is awaiting exact human approval; inspect operation status",
    );
  }
  if (operation.inputFingerprint !== argsFingerprint)
    throw new Error("Operation id was replayed with different input");
  if (operation.state === "completed") {
    // SAFETY: this operation row is scoped to the same tool, stable id, and
    // exact args fingerprint; the registration layer parses T again.
    return operation.result as T;
  }
  if (operation.state !== "paused_approval")
    throw new Error("Mutation outcome is uncertain; inspect operation status");
  if (run.status !== "paused_approval")
    throw new Error(`Purchase-agent run is fenced in ${run.status}`);

  const [approval] = await getDb(input.db)
    .select()
    .from(runApproval)
    .where(
      and(
        eq(runApproval.runId, run.id),
        eq(runApproval.operationId, input.execution.operationId),
        eq(runApproval.state, "granted"),
      ),
    )
    .limit(1);
  if (
    !approval ||
    approval.argsFingerprint !== argsFingerprint ||
    approval.targetFingerprint !== targetFingerprint ||
    approval.evidenceFingerprint !== evidenceFingerprint ||
    JSON.stringify(approval.args) !== JSON.stringify(args)
  )
    throw new Error("Exact mutation approval is missing or target changed");

  return input.operationContext.inTransaction(async (prepared) => {
    const transactionDb = prepared.entityKernel.db;
    const database = getDb(transactionDb);
    const [[lockedRun], [lockedOperation], [lockedApproval]] =
      await Promise.all([
        database
          .select({ status: runTable.status })
          .from(runTable)
          .where(eq(runTable.id, run.id))
          .limit(1)
          .for("update"),
        database
          .select({ state: runOperation.state })
          .from(runOperation)
          .where(
            and(
              eq(runOperation.runId, run.id),
              eq(runOperation.operationId, input.execution.operationId),
            ),
          )
          .limit(1)
          .for("update"),
        database
          .select({
            state: runApproval.state,
            argsFingerprint: runApproval.argsFingerprint,
            targetFingerprint: runApproval.targetFingerprint,
            evidenceFingerprint: runApproval.evidenceFingerprint,
          })
          .from(runApproval)
          .where(eq(runApproval.id, approval.id))
          .limit(1)
          .for("update"),
      ]);
    const currentTargetFingerprint = await purchaseAgentTargetFingerprint(
      transactionDb,
      args,
    );
    if (
      lockedRun?.status !== "paused_approval" ||
      lockedOperation?.state !== "paused_approval" ||
      lockedApproval?.state !== "granted" ||
      lockedApproval.argsFingerprint !== argsFingerprint ||
      lockedApproval.targetFingerprint !== currentTargetFingerprint ||
      lockedApproval.evidenceFingerprint !== evidenceFingerprint
    ) {
      throw new Error("Mutation approval changed or target is stale");
    }
    const transactionalExtra: ToolExtra = {
      ...input.baseExtra,
      authInfo: input.baseExtra.authInfo
        ? {
            ...input.baseExtra.authInfo,
            extra: { ...input.baseExtra.authInfo.extra, ...prepared },
          }
        : undefined,
    };
    const result = await input.run(transactionalExtra);
    const postFingerprint = await sha256(JSON.stringify(result));
    const resultArguments = purchaseAgentArguments.parse(result);
    const refs = await targetSnapshot(transactionDb, [args, resultArguments]);
    const provenance = refs.flatMap((ref) =>
      ref.id && auditEntitySchema.safeParse(ref.type).success
        ? [
            {
              runId: run.id,
              targetKind: ref.type,
              targetId: ref.id,
              mutationKind: "update",
              fields: [input.toolName],
              postFingerprint,
            },
          ]
        : [],
    );
    if (provenance.length > 0)
      await database.insert(runMutation).values(provenance);
    await database
      .update(runApproval)
      .set({ state: "consumed", consumedAt: new Date() })
      .where(eq(runApproval.id, approval.id));
    await database
      .update(runOperation)
      .set({
        state: "completed",
        result,
        error: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(runOperation.runId, run.id),
          eq(runOperation.operationId, input.execution.operationId),
        ),
      );
    const remainingApprovals = await database
      .select({ id: runApproval.id })
      .from(runApproval)
      .where(
        and(
          eq(runApproval.runId, run.id),
          inArray(runApproval.state, ["pending", "granted"]),
        ),
      )
      .limit(1);
    await database
      .update(runTable)
      .set({
        status: remainingApprovals.length > 0 ? "paused_approval" : "running",
        failureCode: null,
        updatedAt: new Date(),
      })
      .where(eq(runTable.id, run.id));
    return result;
  });
}
