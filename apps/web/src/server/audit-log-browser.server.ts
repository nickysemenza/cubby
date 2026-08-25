import { auditLogListInput, auditLogListOut } from "@cubby/schemas/audit";
import type { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import { listAuditLog } from "~/server/workflows/audit-log";

/** Browser adapter: authenticated, strongly consistent, schema-checked read. */
export async function getAuditLogForBrowser(options: {
  data: z.input<typeof auditLogListInput>;
  request: StartOperationRequest;
}) {
  return await runStartOperation({
    operation: "auditLog.list",
    type: "query",
    input: options.data,
    inputSchema: auditLogListInput,
    outputSchema: auditLogListOut,
    request: options.request,
    readPolicy: "strong",
    run: async (context, input) =>
      await listAuditLog({ db: context.db, data: input }),
  });
}
