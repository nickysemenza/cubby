import type { auditLogListInput, auditLogListOut } from "@cubby/schemas/audit";
import { z } from "zod";

import { auditLog } from "~/integrations/tanstack-query/generated/catalog.gen";

type AuditLogListInput = z.input<typeof auditLogListInput>;

export function auditLogListOptions(
  input: AuditLogListInput,
  options: {
    getNextPageParam?: (
      lastPage: z.output<typeof auditLogListOut>,
    ) => string | undefined;
  } = {},
  list = auditLog.list,
) {
  const { cursor, ...inputWithoutCursor } = input;
  return list.infiniteQueryOptions(inputWithoutCursor, {
    pageParamSchema: z.string().nullable(),
    page: (pageInput, pageParam) => {
      const page = { ...pageInput };
      if (pageParam !== null) page.cursor = pageParam;
      return page;
    },
    initialPageParam: cursor ?? null,
    getNextPageParam:
      options.getNextPageParam ?? ((lastPage) => lastPage.nextCursor),
  });
}

export type AuditLogEntry = z.output<typeof auditLogListOut>["entries"][number];
