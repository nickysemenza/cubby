import type { AuditEntityKind } from "@cubby/schemas/audit";
import type { ActorContext } from "@cubby/schemas/context";

import type { Database, DrizzleTransaction } from "~/server/db";
import { logAuditEntries } from "~/server/repo/audit-log";

/** A row a Run wrote directly, without a kernel write that audits itself. */
export type RunWrite = {
  entityKind: AuditEntityKind;
  entityId: string;
  action: "create" | "update";
  /** The fields the write touched; the audit row names them without values. */
  fields: readonly string[];
};

/**
 * Record a Run's direct writes in the shared AuditLog, carrying the Run's id.
 * The importers insert rows with raw statements, so nothing else records that
 * this Run wrote them; `actor` must already name the Run.
 */
export async function recordRunWrites(
  db: Database | DrizzleTransaction,
  actor: ActorContext,
  writes: readonly RunWrite[],
): Promise<void> {
  if (!actor.runId) throw new Error("A Run's writes are audited under its id");
  await logAuditEntries(
    db,
    actor,
    writes.map((write) => ({
      entityKind: write.entityKind,
      entityId: write.entityId,
      action: write.action,
      changes: Object.fromEntries(
        write.fields.map((field) => [field, { from: null, to: null }]),
      ),
    })),
  );
}
