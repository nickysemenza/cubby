import { auditLog } from "~/lib/audit-log.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { listAuditLog } from "~/server/workflows/audit-log";

/** Browser adapter: authenticated, strongly consistent, schema-checked read. */
export const auditLogHandlers = implementOperationDomain(auditLog, {
  list: {
    run: (context, input) => listAuditLog({ db: context.db, data: input }),
  },
});
