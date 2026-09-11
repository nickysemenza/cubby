import { auditLogContract } from "~/contracts/audit-log.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { listAuditLog } from "~/server/workflows/audit-log";

/** Browser adapter: authenticated, strongly consistent, schema-checked read. */
export const auditLogHandlers = implementOperationDomain(auditLogContract, {
  list: {
    run: (context, input) => listAuditLog({ db: context.db, data: input }),
  },
});
