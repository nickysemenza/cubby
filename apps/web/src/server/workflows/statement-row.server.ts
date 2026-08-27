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
export const listStatementRowsWorkflow = (
  db: Database,
  input: z.output<typeof listStatementRowsInput>,
) =>
  listStatementRows(
    db,
    input.filters ?? {},
    input.pagination,
    Array.isArray(input.sort) ? input.sort[0] : input.sort,
  );
export const getStatementRowSummaryWorkflow = (
  db: Database,
  input: z.output<typeof statementRowSummaryInput>,
) => getStatementRowSummary(db, input.filters ?? {});
export const listStatementImportsWorkflow = (
  db: Database,
  input: z.output<typeof listStatementImportsInput>,
) => listStatementImports(db, input.source);
export const findStatementRowDriftWorkflow = (
  db: Database,
  input: z.output<typeof findStatementRowDriftInput>,
) => findStatementRowDrift(db, input);
export const recordStatementRowsWorkflow = (
  db: Database,
  actor: ActorContext,
  input: z.output<typeof recordStatementRowsInput>,
) => recordStatementRows(db, input, actor);
export const updateStatementRowsWorkflow = (
  db: Database,
  actor: ActorContext,
  input: z.output<typeof updateStatementRowsInput>,
) => updateStatementRows(db, input, actor);
export const deleteStatementRowsWorkflow = (
  db: Database,
  actor: ActorContext,
  input: z.output<typeof deleteStatementRowsInput>,
) => deleteStatementRows(db, input.selector, actor);
