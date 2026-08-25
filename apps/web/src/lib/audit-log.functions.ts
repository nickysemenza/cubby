import { type auditLogListInput, auditLogListOut } from "@cubby/schemas/audit";
import { infiniteQueryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import * as auditLogBrowser from "~/server/audit-log-browser.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";

const getAuditLogTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof auditLogListInput>)
  .handler(
    async ({ data, context }) =>
      await auditLogBrowser.getAuditLogForBrowser({
        data,
        request: context.startOperation,
      }),
  );

const auditLogOperation = startOperation<
  z.input<typeof auditLogListInput>,
  z.output<typeof auditLogListOut>
>({
  operation: "auditLog.list",
  transport: (data, { signal, headers }) =>
    getAuditLogTransport({ data, signal, headers }),
  parse: (result) => auditLogListOut.parse(result),
});

type AuditLogListInput = z.input<typeof auditLogListInput>;

const auditLogListQueryKey = (input: AuditLogListInput) => {
  const { cursor: _cursor, ...inputWithoutCursor } = input;
  return [
    ["auditLog", "list"],
    { input: inputWithoutCursor, type: "infinite" },
  ] as const;
};

export function auditLogListInfiniteQueryOptions(
  input: AuditLogListInput,
  options: {
    getNextPageParam?: (
      lastPage: z.output<typeof auditLogListOut>,
    ) => string | undefined;
  } = {},
) {
  return infiniteQueryOptions({
    queryKey: auditLogListQueryKey(input),
    queryFn: ({ pageParam, signal }) =>
      auditLogOperation.call(
        {
          ...input,
          ...(pageParam === null || pageParam === undefined
            ? {}
            : { cursor: pageParam }),
        },
        { signal },
      ),
    initialPageParam: input.cursor ?? null,
    getNextPageParam:
      options.getNextPageParam ?? ((lastPage) => lastPage.nextCursor),
    meta: auditLogOperation.meta,
  });
}

export type AuditLogEntry = z.output<typeof auditLogListOut>["entries"][number];
