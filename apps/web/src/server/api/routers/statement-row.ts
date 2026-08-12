import {
  deleteStatementRowsInput,
  listStatementImportsInput,
  listStatementRowsInput,
  recordStatementRowsInput,
  recordStatementRowsOut,
  statementImportListOut,
  statementRowListOut,
  statementRowSummaryInput,
  statementRowSummaryOut,
  statementRowWriteOut,
  updateStatementRowsInput,
} from "@cubby/schemas/statement-row";
import {
  deleteStatementRows,
  getStatementRowSummary,
  listStatementImports,
  listStatementRows,
  recordStatementRows,
  updateStatementRows,
} from "~/server/repo/statement-row";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

const list = protectedProcedure
  .input(listStatementRowsInput)
  .output(strictOutput(statementRowListOut))
  .query(({ ctx, input }) =>
    listStatementRows(
      ctx.db,
      input.filters ?? {},
      input.pagination,
      // The shared sort schema accepts one-or-many; this list sorts by a single
      // column plus an id tiebreak, so take the first.
      Array.isArray(input.sort) ? input.sort[0] : input.sort,
    ),
  );

const summary = protectedProcedure
  .input(statementRowSummaryInput)
  .output(strictOutput(statementRowSummaryOut))
  .query(({ ctx, input }) =>
    getStatementRowSummary(ctx.db, input.filters ?? {}),
  );

const imports = protectedProcedure
  .input(listStatementImportsInput)
  .output(strictOutput(statementImportListOut))
  .query(({ ctx, input }) => listStatementImports(ctx.db, input.source));

const record = protectedProcedure
  .input(recordStatementRowsInput)
  .output(strictOutput(recordStatementRowsOut))
  .mutation(({ ctx, input }) =>
    recordStatementRows(ctx.db, input, ctx.actorContext),
  );

const update = protectedProcedure
  .input(updateStatementRowsInput)
  .output(strictOutput(statementRowWriteOut))
  .mutation(({ ctx, input }) =>
    updateStatementRows(ctx.db, input, ctx.actorContext),
  );

const remove = protectedProcedure
  .input(deleteStatementRowsInput)
  .output(strictOutput(statementRowWriteOut))
  .mutation(({ ctx, input }) =>
    deleteStatementRows(ctx.db, input.selector, ctx.actorContext),
  );

export const statementRowRouter = createTRPCRouter({
  list,
  summary,
  imports,
  record,
  update,
  delete: remove,
});
