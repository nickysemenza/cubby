import type { AuditLogListOut, auditLogListInput } from "@cubby/schemas/audit";
import type { z } from "zod";

import type { Database } from "~/server/db";
import { getAuditLog } from "~/server/repo/audit-log";
import { resolveShortcode } from "~/server/repo/shortcode-resolver";
import { bindWorkflow, workflow } from "~/server/workflow-runtime";

type AuditInput = z.output<typeof auditLogListInput>;
const auditLogWorkflow = workflow<Database, AuditInput>("auditLog.list")
  .call("subject", async ({ context: db }, { input }) => ({
    data: input,
    resolved: input.entityId
      ? await resolveShortcode(db, input.entityId)
      : null,
  }))
  .branch("result", {
    when: async (_, { subject }) =>
      !(
        subject.data.entityId &&
        (!subject.resolved ||
          (subject.data.entityType &&
            subject.resolved.entity !== subject.data.entityType))
      ),
    whenTrue: (branch) =>
      branch
        .call("entries", async ({ context: db }, { input: { subject } }) =>
          getAuditLog(db, {
            entityType: subject.data.entityType,
            entityId: subject.resolved?.id,
            source: subject.data.source,
            createdAtFrom: subject.data.createdAtFrom,
            createdAtTo: subject.data.createdAtTo,
            limit: subject.data.limit,
            cursor: subject.data.cursor,
          }),
        )
        .output(({ entries }) => entries),
    whenFalse: (branch) =>
      branch
        .call("empty", async (): Promise<AuditLogListOut> => ({ entries: [] }))
        .output(({ empty }) => empty),
  })
  .output(({ result }) => result);

/** Unknown or mismatched public subjects deliberately produce an empty log. */
export const listAuditLog = bindWorkflow(
  auditLogWorkflow,
  ({ db, data }: { db: Database; data: AuditInput }) => ({
    context: db,
    input: data,
  }),
);
