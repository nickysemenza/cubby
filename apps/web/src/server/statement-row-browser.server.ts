import type { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import {
  getStatementRowSummaryWorkflow,
  listStatementImportsWorkflow,
  listStatementRowsWorkflow,
  statementRowWorkflowSchemas,
} from "~/server/workflows/statement-row.server";

const schemas = statementRowWorkflowSchemas;
export const listStatementRowsForBrowser = (o: {
  data: z.input<typeof schemas.list.input>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "statementRow.list",
    type: "query",
    input: o.data,
    inputSchema: schemas.list.input,
    outputSchema: schemas.list.output,
    request: o.request,
    readPolicy: "strong",
    run: (c, input) => listStatementRowsWorkflow(c.db, input),
  });
export const getStatementRowSummaryForBrowser = (o: {
  data: z.input<typeof schemas.summary.input>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "statementRow.summary",
    type: "query",
    input: o.data,
    inputSchema: schemas.summary.input,
    outputSchema: schemas.summary.output,
    request: o.request,
    readPolicy: "strong",
    run: (c, input) => getStatementRowSummaryWorkflow(c.db, input),
  });
export const listStatementImportsForBrowser = (o: {
  data: z.input<typeof schemas.imports.input>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "statementRow.imports",
    type: "query",
    input: o.data,
    inputSchema: schemas.imports.input,
    outputSchema: schemas.imports.output,
    request: o.request,
    readPolicy: "strong",
    run: (c, input) => listStatementImportsWorkflow(c.db, input),
  });
