import { auditLogContract } from "~/contracts/audit-log.contract";

import { defineOperationDomain } from "../operation-catalog";

export const auditLog = /* @__PURE__ */ defineOperationDomain(auditLogContract);
