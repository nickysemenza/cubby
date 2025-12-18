/**
 * Google Sheets Integration Router
 *
 * Provides two-way sync between inventory and Google Sheets:
 * - Push: Export inventory data to a connected Google Sheet
 * - Pull: Import inventory data from the Google Sheet (with preview)
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  protectedProcedure,
  requireActorContext,
} from "~/server/api/trpc";
import {
  getGoogleSheetsClient,
  GoogleSheetsClient,
} from "~/server/clients/google-sheets";
import { exportInventoryToCSV } from "~/server/repo/inventory/csv-export";
import { importInventoryFromCSV } from "~/server/repo/inventory/csv-import";
import {
  inventoryCSVRow,
  csvImportResult,
  type InventoryCSVRow,
  type CSVImportResult,
  type CSVImportResultItem,
} from "~/schemas/inventory";
import { organization } from "~/server/db/auth.schema";
import { eq } from "drizzle-orm";
import { getDb } from "~/server/repo/database-helpers";
import { toCSVString } from "~/lib/csv-utils";
import {
  compareInventoryForPush,
  findRemovedInventoryForPull,
} from "~/server/repo/inventory/csv-comparison";
import { deleteInventoryEntry } from "~/server/repo/inventory";
import { deleteProduct } from "~/server/repo/product";

// Schema for organization metadata with Google Sheets config
const googleSheetsMetadata = z.object({
  googleSheetId: z.string().nullable().optional(),
  googleSheetLastSync: z.string().nullable().optional(),
});

type GoogleSheetsMetadata = z.infer<typeof googleSheetsMetadata>;

// Parse organization metadata from JSON string
function parseOrgMetadata(metadataStr: string | null): GoogleSheetsMetadata {
  if (!metadataStr) return {};
  try {
    const parsed = JSON.parse(metadataStr);
    return googleSheetsMetadata.parse(parsed);
  } catch {
    return {};
  }
}

// Merge new metadata with existing, preserving other fields
function mergeOrgMetadata(
  existing: string | null,
  updates: Partial<GoogleSheetsMetadata>,
): string {
  const current = existing ? JSON.parse(existing) : {};
  return JSON.stringify({ ...current, ...updates });
}

// CSV column headers for Google Sheets
const CSV_HEADERS = [
  "product_name",
  "manufacturer",
  "upc",
  "model",
  "ndb_number",
  "location_path",
  "quantity",
  "unit",
  "expected_qty",
  "price",
  "unit_mappings",
  "ingredient_name",
  "aliases",
];

// Parse currency string to number (handles $, commas, etc.)
function parseCurrency(value: string | undefined): number | undefined {
  if (!value || value.trim() === "") return undefined;
  // Strip currency symbols, commas, and whitespace
  const cleaned = value.replace(/[$,\s]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? undefined : num;
}

// Parse error for a sheet row
type SheetParseError = {
  rowIndex: number;
  productName: string;
  error: string;
};

// Result of parsing sheet rows
type ParseSheetResult = {
  rows: InventoryCSVRow[];
  errors: SheetParseError[];
};

// Helper context type for procedures that need sheet access
type SheetContext = {
  db: Parameters<typeof getDb>[0];
  organizationId: string;
};

// Get configured client and validated sheet ID, or throw appropriate error
async function getClientAndSheetId(ctx: SheetContext): Promise<{
  client: ReturnType<typeof getGoogleSheetsClient>;
  sheetId: string;
  orgMetadata: string | null;
}> {
  const client = getGoogleSheetsClient();

  if (!client.isConfigured()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Google Sheets integration is not configured",
    });
  }

  const org = await getDb(ctx.db).query.organization.findFirst({
    where: eq(organization.id, ctx.organizationId),
    columns: { metadata: true },
  });

  const metadata = parseOrgMetadata(org?.metadata ?? null);
  const sheetId = metadata.googleSheetId;

  if (!sheetId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "No Google Sheet connected. Please connect a sheet first.",
    });
  }

  return { client, sheetId, orgMetadata: org?.metadata ?? null };
}

// Convert parse errors to CSVImportResultItem array
function parseErrorsToItems(errors: SheetParseError[]): CSVImportResultItem[] {
  return errors.map((err) => ({
    rowIndex: err.rowIndex,
    action: "error" as const,
    productName: err.productName,
    message: err.error,
  }));
}

// Empty import result constant
const EMPTY_IMPORT_RESULT: CSVImportResult = {
  created: 0,
  moved: 0,
  updated: 0,
  skipped: 0,
  errors: 0,
  productOnly: 0,
  items: [],
};

// Update organization's last sync timestamp
async function updateLastSyncTimestamp(
  ctx: SheetContext,
  existingMetadata: string | null,
): Promise<void> {
  const newMetadata = mergeOrgMetadata(existingMetadata, {
    googleSheetLastSync: new Date().toISOString(),
  });

  await getDb(ctx.db)
    .update(organization)
    .set({ metadata: newMetadata })
    .where(eq(organization.id, ctx.organizationId));
}

// Merge import result with parse errors
function mergeResultWithErrors(
  result: CSVImportResult,
  errorItems: CSVImportResultItem[],
): CSVImportResult {
  return {
    ...result,
    errors: result.errors + errorItems.length,
    items: [...result.items, ...errorItems],
  };
}

// Convert sheet rows (2D array) to InventoryCSVRow[]
function parseSheetRows(rows: string[][]): ParseSheetResult {
  if (rows.length < 2) return { rows: [], errors: [] }; // Need header + at least one data row

  const headers = rows[0].map((h) =>
    h.toLowerCase().trim().replace(/\s+/g, "_"),
  );
  const dataRows = rows.slice(1);

  const parsed: InventoryCSVRow[] = [];
  const errors: SheetParseError[] = [];

  for (let rowIdx = 0; rowIdx < dataRows.length; rowIdx++) {
    const row = dataRows[rowIdx];
    // Create object from headers and row values
    const rowObj: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      rowObj[headers[i]] = row[i] ?? "";
    }

    // Skip empty rows
    const productName =
      rowObj.product_name || rowObj.product || rowObj.name || "";
    if (!productName) {
      continue;
    }

    const result = inventoryCSVRow.safeParse({
      product_name: productName,
      manufacturer: rowObj.manufacturer || undefined,
      upc: rowObj.upc || rowObj.barcode || undefined,
      model: rowObj.model || undefined,
      ndb_number: rowObj.ndb_number || rowObj.ndbnumber || undefined,
      location_path: rowObj.location_path || rowObj.location || undefined,
      quantity: rowObj.quantity || rowObj.qty || 1,
      unit: rowObj.unit || "each",
      expected_qty: rowObj.expected_qty || rowObj.expectedqty || undefined,
      price: parseCurrency(rowObj.price),
      unit_mappings: rowObj.unit_mappings || rowObj.unitmappings || undefined,
      ingredient_name: rowObj.ingredient_name || undefined,
      ingredient: rowObj.ingredient,
      aliases: rowObj.aliases || undefined,
    });

    if (result.success) {
      parsed.push(result.data);
    } else {
      // Capture the first error message
      const firstIssue = result.error.issues[0];
      const errorMsg = firstIssue
        ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
        : "Invalid row data";
      errors.push({
        rowIndex: rowIdx + 2, // +2 for 1-based index and header row
        productName,
        error: errorMsg,
      });
    }
  }

  return { rows: parsed, errors };
}

// Get connection status
const getConnectionStatus = protectedProcedure
  .output(
    z.object({
      configured: z.boolean(),
      connected: z.boolean(),
      sheetId: z.string().nullable(),
      sheetName: z.string().nullable(),
      lastSync: z.string().nullable(),
      serviceAccountEmail: z.string().nullable(),
    }),
  )
  .query(async ({ ctx }) => {
    const client = getGoogleSheetsClient();
    const configured = client.isConfigured();
    const serviceAccountEmail = client.getServiceAccountEmail() ?? null;

    // Get org metadata
    const org = await getDb(ctx.db).query.organization.findFirst({
      where: eq(organization.id, ctx.organizationId),
      columns: { metadata: true },
    });

    const metadata = parseOrgMetadata(org?.metadata ?? null);
    const sheetId = metadata.googleSheetId ?? null;
    const lastSync = metadata.googleSheetLastSync ?? null;

    // Check if we can access the sheet
    let sheetName: string | null = null;
    let connected = false;

    if (configured && sheetId) {
      sheetName = await client.validateAccess(sheetId);
      connected = sheetName !== null;
    }

    return {
      configured,
      connected,
      sheetId,
      sheetName,
      lastSync,
      serviceAccountEmail,
    };
  });

// Test connection to a sheet URL
const testConnection = protectedProcedure
  .input(
    z.object({
      sheetUrl: z.string().url(),
    }),
  )
  .output(
    z.object({
      success: z.boolean(),
      sheetId: z.string().nullable(),
      sheetName: z.string().nullable(),
      error: z.string().nullable(),
    }),
  )
  .mutation(async ({ input }) => {
    const client = getGoogleSheetsClient();

    if (!client.isConfigured()) {
      return {
        success: false,
        sheetId: null,
        sheetName: null,
        error:
          "Google Sheets integration is not configured. Please set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY environment variables.",
      };
    }

    const sheetId = GoogleSheetsClient.extractSheetId(input.sheetUrl);
    if (!sheetId) {
      return {
        success: false,
        sheetId: null,
        sheetName: null,
        error:
          "Invalid Google Sheets URL. Expected format: https://docs.google.com/spreadsheets/d/{sheetId}/...",
      };
    }

    const sheetName = await client.validateAccess(sheetId);
    if (!sheetName) {
      const email = client.getServiceAccountEmail();
      return {
        success: false,
        sheetId,
        sheetName: null,
        error: `Cannot access the sheet. Make sure you've shared it with ${email} as an Editor.`,
      };
    }

    return {
      success: true,
      sheetId,
      sheetName,
      error: null,
    };
  });

// Save sheet connection to organization
const updateSheetConnection = protectedProcedure
  .input(
    z.object({
      sheetUrl: z.string().url().nullable(),
    }),
  )
  .output(z.object({ success: z.boolean() }))
  .mutation(async ({ ctx, input }) => {
    const sheetId = input.sheetUrl
      ? GoogleSheetsClient.extractSheetId(input.sheetUrl)
      : null;

    // Get current metadata
    const org = await getDb(ctx.db).query.organization.findFirst({
      where: eq(organization.id, ctx.organizationId),
      columns: { metadata: true },
    });

    // Update metadata with new sheet ID
    const newMetadata = mergeOrgMetadata(org?.metadata ?? null, {
      googleSheetId: sheetId,
      googleSheetLastSync: null, // Reset last sync when changing sheet
    });

    await getDb(ctx.db)
      .update(organization)
      .set({ metadata: newMetadata })
      .where(eq(organization.id, ctx.organizationId));

    return { success: true };
  });

// Preview what pushing to sheet would do
const previewPush = protectedProcedure
  .output(csvImportResult)
  .mutation(async ({ ctx }) => {
    const { client, sheetId } = await getClientAndSheetId(ctx);

    // Get app inventory and current sheet data
    const appRows = await exportInventoryToCSV(ctx.db, ctx.organizationId);
    const sheetData = await client.readSheet(sheetId);
    const { rows: sheetRows } = parseSheetRows(sheetData);

    return compareInventoryForPush(appRows, sheetRows);
  });

// Push inventory to Google Sheet
const pushToSheet = protectedProcedure
  .output(
    z.object({
      success: z.boolean(),
      rowCount: z.number(),
    }),
  )
  .mutation(async ({ ctx }) => {
    const { client, sheetId, orgMetadata } = await getClientAndSheetId(ctx);

    // Export inventory to rows
    const exportRows = await exportInventoryToCSV(ctx.db, ctx.organizationId);

    // Convert to string[][] for Google Sheets
    const dataRows = exportRows.map((row) =>
      CSV_HEADERS.map((h) => toCSVString(row[h as keyof typeof row])),
    );

    // Write to sheet (headers + data)
    await client.writeSheet(sheetId, [CSV_HEADERS, ...dataRows]);
    await updateLastSyncTimestamp(ctx, orgMetadata);

    return { success: true, rowCount: exportRows.length };
  });

// Pull from Google Sheet (preview mode)
const pullFromSheet = protectedProcedure
  .output(csvImportResult)
  .mutation(async ({ ctx }) => {
    const { client, sheetId } = await getClientAndSheetId(ctx);
    const actor = requireActorContext(ctx);

    // Read and parse sheet data
    const sheetData = await client.readSheet(sheetId);
    const { rows: parsedRows, errors: parseErrors } = parseSheetRows(sheetData);
    const errorItems = parseErrorsToItems(parseErrors);

    // Get current app inventory to detect deletions
    const appRows = await exportInventoryToCSV(ctx.db, ctx.organizationId);
    const removedItems = findRemovedInventoryForPull(appRows, parsedRows);

    if (
      parsedRows.length === 0 &&
      errorItems.length === 0 &&
      removedItems.length === 0
    ) {
      return EMPTY_IMPORT_RESULT;
    }

    // Run import in preview mode
    const result = await importInventoryFromCSV(
      ctx.db,
      actor.organizationId,
      parsedRows,
      {
        dryRun: true,
        actor: { ...actor, source: "sheets_import" },
      },
    );

    // Add removed items to result
    const mergedResult = mergeResultWithErrors(result, errorItems);
    return {
      ...mergedResult,
      removed: (mergedResult.removed ?? 0) + removedItems.length,
      items: [...mergedResult.items, ...removedItems],
    };
  });

// Apply pull from Google Sheet
const applyPull = protectedProcedure
  .output(csvImportResult)
  .mutation(async ({ ctx }) => {
    const { client, sheetId, orgMetadata } = await getClientAndSheetId(ctx);
    const actor = requireActorContext(ctx);

    // Read and parse sheet data
    const sheetData = await client.readSheet(sheetId);
    const { rows: parsedRows, errors: parseErrors } = parseSheetRows(sheetData);
    const errorItems = parseErrorsToItems(parseErrors);

    // Get current app inventory to detect deletions
    const appRows = await exportInventoryToCSV(ctx.db, ctx.organizationId);
    const removedItems = findRemovedInventoryForPull(appRows, parsedRows);

    if (
      parsedRows.length === 0 &&
      errorItems.length === 0 &&
      removedItems.length === 0
    ) {
      return EMPTY_IMPORT_RESULT;
    }

    // Run actual import
    const result = await importInventoryFromCSV(
      ctx.db,
      actor.organizationId,
      parsedRows,
      {
        dryRun: false,
        actor: { ...actor, source: "sheets_import" },
      },
    );

    // Delete inventory entries and products that were removed from the sheet
    for (const item of removedItems) {
      if (item.inventoryEntryId) {
        // Delete inventory entry (product with location was removed)
        await deleteInventoryEntry(ctx.db, item.inventoryEntryId, {
          ...actor,
          source: "sheets_import",
        });
      } else if (item.productIdToDelete) {
        // Delete product (product-only row was removed)
        await deleteProduct(ctx.db, item.productIdToDelete, {
          ...actor,
          source: "sheets_import",
        });
      }
    }

    await updateLastSyncTimestamp(ctx, orgMetadata);

    // Add removed items to result
    const mergedResult = mergeResultWithErrors(result, errorItems);
    return {
      ...mergedResult,
      removed: (mergedResult.removed ?? 0) + removedItems.length,
      items: [...mergedResult.items, ...removedItems],
    };
  });

// Debug endpoint - returns raw sheet data for troubleshooting
const debugSheetData = protectedProcedure
  .output(
    z.object({
      headers: z.array(z.string()),
      rawRows: z.array(z.array(z.string())),
      parsedRows: z.array(inventoryCSVRow),
      parseErrors: z.array(
        z.object({
          rowIndex: z.number(),
          productName: z.string(),
          error: z.string(),
        }),
      ),
    }),
  )
  .query(async ({ ctx }) => {
    const { client, sheetId } = await getClientAndSheetId(ctx);

    // Read raw sheet data
    const rawData = await client.readSheet(sheetId);
    const headers = rawData[0]?.map((h) => h ?? "") ?? [];
    const rawRows = rawData
      .slice(1)
      .map((row) => row.map((cell) => cell ?? ""));

    // Parse rows
    const { rows: parsedRows, errors: parseErrors } = parseSheetRows(rawData);

    return { headers, rawRows, parsedRows, parseErrors };
  });

export const googleSheetsRouter = createTRPCRouter({
  getConnectionStatus,
  testConnection,
  updateSheetConnection,
  previewPush,
  pushToSheet,
  pullFromSheet,
  applyPull,
  debugSheetData,
});
