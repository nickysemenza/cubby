/**
 * CSV Import/Export Factory
 *
 * Creates standardized tRPC procedures for CSV operations:
 * - importCSV: Import rows with actual changes
 * - previewCSVImport: Preview what import would do (dry run)
 * - exportCSV: Export data to CSV format
 */

import { z, type ZodSchema } from "zod";
import { protectedProcedure } from "./trpc";
import type { ProtectedCrudServices } from "./crud-factory";

/**
 * Configuration for CSV procedures (simple case without export input)
 */
interface CSVProceduresConfigSimple<TImportRow, TImportResult, TExportRow> {
  schemas: {
    importRow: ZodSchema<TImportRow>;
    importResult: ZodSchema<TImportResult>;
    exportRow: ZodSchema<TExportRow>;
  };
  repo: {
    import: (
      ctx: ProtectedCrudServices,
      rows: TImportRow[],
      dryRun: boolean,
    ) => Promise<TImportResult>;
    export: (ctx: ProtectedCrudServices) => Promise<TExportRow[]>;
  };
  afterImport?: (
    ctx: ProtectedCrudServices,
    rows: TImportRow[],
    result: TImportResult,
  ) => Promise<TImportResult>;
}

/**
 * Configuration for CSV procedures with export input
 */
interface CSVProceduresConfigWithInput<
  TImportRow,
  TImportResult,
  TExportRow,
  TExportInput,
> {
  schemas: {
    importRow: ZodSchema<TImportRow>;
    importResult: ZodSchema<TImportResult>;
    exportRow: ZodSchema<TExportRow>;
    exportInput: ZodSchema<TExportInput>;
  };
  repo: {
    import: (
      ctx: ProtectedCrudServices,
      rows: TImportRow[],
      dryRun: boolean,
    ) => Promise<TImportResult>;
    export: (
      ctx: ProtectedCrudServices,
      input: TExportInput,
    ) => Promise<TExportRow[]>;
  };
  afterImport?: (
    ctx: ProtectedCrudServices,
    rows: TImportRow[],
    result: TImportResult,
  ) => Promise<TImportResult>;
}

/**
 * Creates CSV procedures for simple case (no export input)
 *
 * @example
 * const { importCSV, previewCSVImport, exportCSV } = createCSVProcedures({
 *   schemas: {
 *     importRow: locationCSVRow,
 *     importResult: locationCSVImportResult,
 *     exportRow: locationExportRowSchema,
 *   },
 *   repo: {
 *     import: (ctx, rows, dryRun) =>
 *       importLocationsFromCSV(ctx.db, ctx.organizationId, rows, { dryRun }),
 *     export: (ctx) =>
 *       exportLocationsToCSV(ctx.db, ctx.organizationId),
 *   },
 * });
 */
export function createCSVProcedures<TImportRow, TImportResult, TExportRow>(
  config: CSVProceduresConfigSimple<TImportRow, TImportResult, TExportRow>,
) {
  const { schemas, repo, afterImport } = config;

  const importCSV = protectedProcedure
    .input(z.object({ rows: z.array(schemas.importRow) }))
    .output(schemas.importResult)
    .mutation(async ({ ctx, input }) => {
      const result = await repo.import(ctx, input.rows as TImportRow[], false);
      if (afterImport) {
        return await afterImport(ctx, input.rows as TImportRow[], result);
      }
      return result;
    });

  const previewCSVImport = protectedProcedure
    .input(z.object({ rows: z.array(schemas.importRow) }))
    .output(schemas.importResult)
    .mutation(async ({ ctx, input }) => {
      return await repo.import(ctx, input.rows as TImportRow[], true);
    });

  const exportCSV = protectedProcedure
    .output(z.array(schemas.exportRow))
    .query(async ({ ctx }) => {
      return await repo.export(ctx);
    });

  return { importCSV, previewCSVImport, exportCSV };
}

/**
 * Creates CSV procedures with export input (like inventory with locationId filter)
 *
 * @example
 * const { importCSV, previewCSVImport, exportCSV } = createCSVProceduresWithExportInput({
 *   schemas: {
 *     importRow: inventoryCSVRow,
 *     importResult: csvImportResult,
 *     exportRow: inventoryExportRowSchema,
 *     exportInput: z.object({ locationId: locationId.optional() }),
 *   },
 *   repo: {
 *     import: (ctx, rows, dryRun) =>
 *       importInventoryFromCSV(ctx.db, ctx.organizationId, rows, {
 *         dryRun,
 *         actor: { ...ctx.actorContext, source: "csv_import" },
 *       }),
 *     export: (ctx, input) =>
 *       exportInventoryToCSV(ctx.db, ctx.organizationId, input.locationId),
 *   },
 *   afterImport: async (ctx, rows, result) => {
 *     // Import UPC images for new products...
 *     return result;
 *   },
 * });
 */
export function createCSVProceduresWithExportInput<
  TImportRow,
  TImportResult,
  TExportRow,
  TExportInput,
>(
  config: CSVProceduresConfigWithInput<
    TImportRow,
    TImportResult,
    TExportRow,
    TExportInput
  >,
) {
  const { schemas, repo, afterImport } = config;

  const importCSV = protectedProcedure
    .input(z.object({ rows: z.array(schemas.importRow) }))
    .output(schemas.importResult)
    .mutation(async ({ ctx, input }) => {
      const result = await repo.import(ctx, input.rows as TImportRow[], false);
      if (afterImport) {
        return await afterImport(ctx, input.rows as TImportRow[], result);
      }
      return result;
    });

  const previewCSVImport = protectedProcedure
    .input(z.object({ rows: z.array(schemas.importRow) }))
    .output(schemas.importResult)
    .mutation(async ({ ctx, input }) => {
      return await repo.import(ctx, input.rows as TImportRow[], true);
    });

  const exportCSV = protectedProcedure
    .input(schemas.exportInput)
    .output(z.array(schemas.exportRow))
    .query(async ({ ctx, input }) => {
      return await repo.export(ctx, input as TExportInput);
    });

  return { importCSV, previewCSVImport, exportCSV };
}
