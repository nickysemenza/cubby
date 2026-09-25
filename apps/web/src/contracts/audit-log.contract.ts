import { auditLogListInput, auditLogListOut } from "@cubby/schemas/audit";

import { defineContract, query } from "~/contracts/define";

export const auditLogContract = defineContract("auditLog", {
  list: query({
    input: auditLogListInput,
    output: auditLogListOut,
    native: "Native recent activity and audit history",
  }),
});
