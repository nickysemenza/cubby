import { auditLogListInput, auditLogListOut } from "@cubby/schemas/audit";

import { defineContract, query } from "~/contracts/define";

export const auditLogContract = defineContract("auditLog", {
  // Audit activity reads live and bypasses the freshness RPC before PostgreSQL.
  list: query({
    readPolicy: "strong",
    input: auditLogListInput,
    output: auditLogListOut,
    native: "Native recent activity and audit history",
  }),
});
