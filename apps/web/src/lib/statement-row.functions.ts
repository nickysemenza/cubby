import {
  type listStatementImportsInput,
  type listStatementRowsInput,
  statementImportListOut,
  statementRowListOut,
  type statementRowSummaryInput,
  statementRowSummaryOut,
} from "@cubby/schemas/statement-row";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";
import * as browser from "~/server/statement-row-browser.server";

const listTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof listStatementRowsInput>)
  .handler(({ data, context }) =>
    browser.listStatementRowsForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const summaryTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof statementRowSummaryInput>)
  .handler(({ data, context }) =>
    browser.getStatementRowSummaryForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const importsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof listStatementImportsInput>)
  .handler(({ data, context }) =>
    browser.listStatementImportsForBrowser({
      data,
      request: context.startOperation,
    }),
  );

const listOperation = startOperation({
  operation: "statementRow.list",
  transport: (
    data: z.input<typeof listStatementRowsInput>,
    { signal, headers },
  ) => listTransport({ data, signal, headers }),
  parse: (result) => statementRowListOut.parse(result),
});
const summaryOperation = startOperation({
  operation: "statementRow.summary",
  transport: (
    data: z.input<typeof statementRowSummaryInput>,
    { signal, headers },
  ) => summaryTransport({ data, signal, headers }),
  parse: (result) => statementRowSummaryOut.parse(result),
});
const importsOperation = startOperation({
  operation: "statementRow.imports",
  transport: (
    data: z.input<typeof listStatementImportsInput>,
    { signal, headers },
  ) => importsTransport({ data, signal, headers }),
  parse: (result) => statementImportListOut.parse(result),
});

export const statementRowsListQueryOptions = (
  input: z.input<typeof listStatementRowsInput>,
) =>
  queryOptions({
    queryKey: [["statementRow", "list"], { input, type: "query" }] as const,
    meta: listOperation.meta,
    queryFn: ({ signal }) => listOperation.call(input, { signal }),
  });
export const statementRowsSummaryQueryOptions = (
  input: z.input<typeof statementRowSummaryInput>,
) =>
  queryOptions({
    queryKey: [["statementRow", "summary"], { input, type: "query" }] as const,
    meta: summaryOperation.meta,
    queryFn: ({ signal }) => summaryOperation.call(input, { signal }),
  });
export const statementRowsImportsQueryOptions = (
  input: z.input<typeof listStatementImportsInput>,
) =>
  queryOptions({
    queryKey: [["statementRow", "imports"], { input, type: "query" }] as const,
    meta: importsOperation.meta,
    queryFn: ({ signal }) => importsOperation.call(input, { signal }),
  });
