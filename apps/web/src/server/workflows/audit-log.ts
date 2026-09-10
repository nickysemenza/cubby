import type { AuditLogListOut, auditLogListInput } from "@cubby/schemas/audit";
import type { z } from "zod";

import type { Database } from "~/server/db";
import { getAuditLog } from "~/server/repo/audit-log";
import { resolveShortcode } from "~/server/repo/shortcode-resolver";
import {
  branchStep,
  callStep,
  defineWorkflow,
  defineWorkflowFunction,
  bindWorkflow,
  workflowInput,
  type WorkflowFunctionContext,
} from "~/server/workflow-runtime";

type AuditInput = z.output<typeof auditLogListInput>;
const resolveAuditSubject = defineWorkflowFunction(
  "auditLog.resolveSubject",
  async (
    { context: db }: WorkflowFunctionContext<Database>,
    data: AuditInput,
  ) => ({
    data,
    resolved: data.entityId ? await resolveShortcode(db, data.entityId) : null,
  }),
);
type AuditScope = Awaited<ReturnType<typeof resolveAuditSubject.run>>;
const validAuditSubject = defineWorkflowFunction(
  "auditLog.validSubject",
  async (
    _execution: WorkflowFunctionContext<Database>,
    { data, resolved }: AuditScope,
  ) =>
    !(
      data.entityId &&
      (!resolved || (data.entityType && resolved.entity !== data.entityType))
    ),
);
const readAudit = defineWorkflowFunction(
  "auditLog.read",
  async (
    { context: db }: WorkflowFunctionContext<Database>,
    { data, resolved }: AuditScope,
  ): Promise<AuditLogListOut> =>
    getAuditLog(db, {
      entityType: data.entityType,
      entityId: resolved?.id,
      source: data.source,
      createdAtFrom: data.createdAtFrom,
      createdAtTo: data.createdAtTo,
      limit: data.limit,
      cursor: data.cursor,
    }),
);
const emptyAudit = defineWorkflowFunction(
  "auditLog.empty",
  async (
    _execution: WorkflowFunctionContext<Database>,
    _scope: AuditScope,
  ): Promise<AuditLogListOut> => ({ entries: [] }),
);
const subject = callStep({
  name: "subject",
  fn: resolveAuditSubject,
  input: workflowInput<AuditInput>(),
});
const entries = callStep({
  name: "entries",
  fn: readAudit,
  input: workflowInput<AuditScope>(),
});
const empty = callStep({
  name: "empty",
  fn: emptyAudit,
  input: workflowInput<AuditScope>(),
});
const result = branchStep({
  name: "result",
  when: validAuditSubject,
  input: subject.output,
  whenTrue: defineWorkflow({
    name: "read",
    steps: [entries],
    output: entries.output,
  }),
  whenFalse: defineWorkflow({
    name: "unknownSubject",
    steps: [empty],
    output: empty.output,
  }),
});
const auditLogWorkflow = defineWorkflow({
  name: "auditLog.list",
  steps: [subject, result],
  output: result.output,
});

/** Unknown or mismatched public subjects deliberately produce an empty log. */
export const listAuditLog = bindWorkflow(
  auditLogWorkflow,
  ({ db, data }: { db: Database; data: AuditInput }) => ({
    context: db,
    input: data,
  }),
);
