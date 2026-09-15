import type { ActorContext } from "@cubby/schemas/context";
import type {
  deleteStatementRowsInput,
  findStatementRowDriftInput,
  listStatementImportsInput,
  listStatementRowsInput,
  recordStatementRowsInput,
  statementRowSummaryInput,
  updateStatementRowsInput,
} from "@cubby/schemas/statement-row";
import type { z } from "zod";

import type { Database } from "~/server/db";
import {
  deleteStatementRows,
  findStatementRowDrift,
  getStatementRowSummary,
  listStatementImports,
  listStatementRows,
  recordStatementRows,
  updateStatementRows,
} from "~/server/repo/statement-row";
import {
  bindWorkflow,
  defineWorkflowOperation,
  workflow,
} from "~/server/workflow-runtime";

export const listStatementRowsWorkflow = defineWorkflowOperation(
  "statementRow.list",
  (db: Database, input: z.output<typeof listStatementRowsInput>) =>
    listStatementRows(
      db,
      input.filters ?? {},
      input.pagination,
      Array.isArray(input.sort) ? input.sort[0] : input.sort,
    ),
);
export const getStatementRowSummaryWorkflow = defineWorkflowOperation(
  "statementRow.summary",
  (db: Database, input: z.output<typeof statementRowSummaryInput>) =>
    getStatementRowSummary(db, input.filters ?? {}),
);
export const listStatementImportsWorkflow = defineWorkflowOperation(
  "statementRow.imports",
  (db: Database, input: z.output<typeof listStatementImportsInput>) =>
    listStatementImports(db, input.source),
);
export const findStatementRowDriftWorkflow = defineWorkflowOperation(
  "statementRow.drift",
  (db: Database, input: z.output<typeof findStatementRowDriftInput>) =>
    findStatementRowDrift(db, input),
);
type StatementRowMutationContext = {
  db: Database;
  actor: ActorContext;
};
type RecordStatementRowsInput = z.output<typeof recordStatementRowsInput>;

export const recordStatementRowsWorkflow = bindWorkflow(
  workflow<StatementRowMutationContext, RecordStatementRowsInput>(
    "statementRow.record",
  )
    .branch("result", {
      when: async (_, { input }) => !input.dryRun,
      whenTrue: (branch) =>
        branch
          .commit("write", async ({ context }, { input: { input } }) =>
            recordStatementRows(context.db, input, context.actor),
          )
          .output(({ write }) => write),
      whenFalse: (branch) =>
        branch
          .call("preview", async ({ context }, { input: { input } }) =>
            recordStatementRows(context.db, input, context.actor),
          )
          .output(({ preview }) => preview),
    })
    .output(({ result }) => result),
  (db: Database, actor: ActorContext, input: RecordStatementRowsInput) => ({
    context: { db, actor },
    input,
  }),
);

export const updateStatementRowsWorkflow = bindWorkflow(
  workflow<
    StatementRowMutationContext,
    z.output<typeof updateStatementRowsInput>
  >("statementRow.update")
    .commit("updated", async ({ context }, { input }) =>
      updateStatementRows(context.db, input, context.actor),
    )
    .output(({ updated }) => updated),
  (
    db: Database,
    actor: ActorContext,
    input: z.output<typeof updateStatementRowsInput>,
  ) => ({ context: { db, actor }, input }),
);

export const deleteStatementRowsWorkflow = bindWorkflow(
  workflow<
    StatementRowMutationContext,
    z.output<typeof deleteStatementRowsInput>
  >("statementRow.delete")
    .commit("deleted", async ({ context }, { input }) =>
      deleteStatementRows(context.db, input.selector, context.actor),
    )
    .output(({ deleted }) => deleted),
  (
    db: Database,
    actor: ActorContext,
    input: z.output<typeof deleteStatementRowsInput>,
  ) => ({ context: { db, actor }, input }),
);
