import { auditLogListInput, auditLogListOut } from "@cubby/schemas/audit";
import type { z } from "zod";
import {
  defineOperationDomain,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

/** @lintignore Discovered by the operation registry generator. */
export const auditLog = defineOperationDomain("auditLog", {
  list: query({
    input: auditLogListInput,
    output: auditLogListOut,
    tags: [["auditLog", "list"]],
  }),
});

type AuditLogListInput = z.input<typeof auditLogListInput>;

export function auditLogListOptions(
  input: AuditLogListInput,
  options: {
    getNextPageParam?: (
      lastPage: z.output<typeof auditLogListOut>,
    ) => string | undefined;
  } = {},
) {
  const { cursor, ...inputWithoutCursor } = input;
  return auditLog.list.infiniteQueryOptions<string | null>(inputWithoutCursor, {
    page: (pageInput, pageParam) => ({
      ...pageInput,
      ...(pageParam === null ? {} : { cursor: pageParam }),
    }),
    initialPageParam: cursor ?? null,
    getNextPageParam:
      options.getNextPageParam ?? ((lastPage) => lastPage.nextCursor),
  });
}

export type AuditLogEntry = z.output<typeof auditLogListOut>["entries"][number];
